import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TOOLBELT_DIR, type RuntimeId } from "@bayma/core";
import { UV } from "../platforms.ts";
import { fetchPinned } from "../shared/download.ts";
import { walkFiles } from "../shared/files.ts";
import { sha256File } from "../shared/hashing.ts";
import { assertSucceeded, runOrThrow } from "../shared/process.ts";
import { bunJUnitReport, runTests } from "../shared/tests.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
} from "./payload.ts";

// The toolbelt: the repository's `toolbelt/` package with its Bun, Python,
// and Rust dependencies installed from their lockfiles against the payload's
// own runtimes, proven by its tests, and stripped of them for the payload.

const SOURCE = "toolbelt";
const SKILL = join("skills", "bayma-toolbelt", "SKILL.md");
/**
 * What the payload does not carry: the tests that prove the toolbelt, and
 * what building and proving it leave behind.
 */
const NOT_SHIPPED = [
  "tests",
  "toolbelt.test.ts",
  "toolbelt.stress.test.ts",
  join("rust", "tests"),
  "build",
  "bayma_toolbelt.egg-info",
  ".ruff_cache",
];

async function provisionUv(context: ProvisionContext): Promise<string> {
  const directory = join(context.workDir, "uv");
  if (!isProvisioned(context, directory, UV.sha256)) {
    resetDirectory(directory);
    mkdirSync(directory, { recursive: true });
    const archive = await fetchPinned(UV, context.downloadsDir, "uv");
    await runOrThrow([
      "tar",
      "-xzf",
      archive,
      "-C",
      directory,
      "--strip-components=1",
    ]);
    markProvisioned(directory, UV.sha256);
  }
  const version = (await runOrThrow([join(directory, "uv"), "--version"]))
    .stdout;
  if (!version.startsWith(`uv ${UV.version} `))
    throw new Error(`pinned uv reports ${version.trim()}`);
  return join(directory, "uv");
}

/** The payload runtime's file named by one of its environment paths. */
function runtimeFile(runtime: RuntimePayload, variable: string): string {
  const path = runtime.envPaths[variable];
  if (!path) throw new Error(`${runtime.runtimeId} names no ${variable}`);
  return join(runtime.root, path);
}

/**
 * The environment's interpreter link, relative, so the installed payload's
 * own Python answers it wherever the payload is unpacked.
 */
function linkPythonRelatively(toolbelt: string): void {
  const link = join(toolbelt, ".venv", "bin", "python");
  rmSync(link, { force: true });
  symlinkSync(join("..", "..", "..", "python", "bin", "python3"), link);
}

function removeUnshipped(toolbelt: string): void {
  for (const path of NOT_SHIPPED)
    rmSync(join(toolbelt, path), { recursive: true, force: true });
  for (const path of walkFiles(toolbelt)) {
    const directory = dirname(path);
    if (directory.endsWith("__pycache__"))
      rmSync(directory, { recursive: true, force: true });
  }
}

export async function provisionToolbelt(
  context: ProvisionContext,
  runtimes: Record<RuntimeId, RuntimePayload>,
): Promise<string> {
  const uv = await provisionUv(context);
  const bun = runtimeFile(runtimes.bun, "BAYMA_BUN_BIN");
  const python = runtimeFile(runtimes.python, "BAYMA_PYTHON_BIN");
  const cargo = runtimeFile(runtimes.rust, "BAYMA_CARGO_BIN");
  const rustc = runtimeFile(runtimes.rust, "BAYMA_RUSTC_BIN");
  const seed = runtimeFile(runtimes.rust, "BAYMA_RUST_CARGO_SEED_DIR");
  const source = join(context.repoRoot, SOURCE);
  // The stage mirrors the payload: the toolbelt beside a `python` that is the
  // payload's interpreter, and the skill where the toolbelt's tests read it.
  const stage = join(context.workDir, "toolbelt");
  const toolbelt = join(stage, TOOLBELT_DIR);
  const identity = [
    UV.sha256,
    runtimes.bun.pins.sha256,
    runtimes.python.pins.sha256,
    runtimes.rust.pins.toolbeltLockSha256,
    sha256File(join(context.repoRoot, SKILL)),
    ...walkFiles(source).map(sha256File),
  ].join(":");
  if (isProvisioned(context, stage, identity)) return toolbelt;

  resetDirectory(stage);
  mkdirSync(join(stage, dirname(SKILL)), { recursive: true });
  symlinkSync(runtimes.python.root, join(stage, "python"));
  copyFileSync(join(context.repoRoot, SKILL), join(stage, SKILL));
  cpSync(source, toolbelt, { recursive: true });

  const uvEnv = {
    UV_CACHE_DIR: join(context.workDir, "uv-cache"),
    UV_PYTHON_DOWNLOADS: "never",
  };
  const syncPython = async () => {
    await runOrThrow(
      [
        uv,
        "sync",
        "--quiet",
        "--frozen",
        "--all-extras",
        "--no-editable",
        "--python",
        python,
      ],
      { cwd: toolbelt, env: uvEnv },
    );
    linkPythonRelatively(toolbelt);
  };
  await runOrThrow([bun, "install", "--frozen-lockfile"], { cwd: toolbelt });
  await runOrThrow(
    [uv, "venv", "--quiet", "--relocatable", "--python", python, ".venv"],
    { cwd: toolbelt, env: uvEnv },
  );
  await syncPython();

  // The toolbelt's own suites, against exactly what the payload will carry.
  // Rust resolves offline from a copy of the seed, which proves the seed
  // holds every crate the toolbelt's lock names.
  const path = `${dirname(uv)}:${dirname(bun)}:${process.env.PATH ?? ""}`;
  const bunTests = [bun, "test"];
  assertSucceeded(
    bunTests,
    await runTests("bun", bunTests, bunJUnitReport, {
      cwd: toolbelt,
      env: { PATH: path },
    }),
  );
  const pythonTests = [
    join(toolbelt, ".venv", "bin", "python"),
    "-m",
    "pytest",
    "tests",
    "-q",
    "-p",
    "no:cacheprovider",
  ];
  assertSucceeded(
    pythonTests,
    await runTests("pytest", pythonTests, (report) => ["--junitxml", report], {
      cwd: toolbelt,
      env: { ...uvEnv, PATH: path },
    }),
  );
  const scratch = mkdtempSync(join(tmpdir(), "bayma-toolbelt-rust-"));
  try {
    cpSync(seed, join(scratch, "cargo-home"), { recursive: true });
    await runOrThrow([cargo, "test", "--locked", "--offline", "--quiet"], {
      cwd: toolbelt,
      env: {
        CARGO_HOME: join(scratch, "cargo-home"),
        CARGO_TARGET_DIR: join(scratch, "target"),
        RUSTC: rustc,
        PATH: `${dirname(cargo)}:${process.env.PATH ?? ""}`,
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // A project runner the tests drove may have re-synced the environment.
  await syncPython();
  removeUnshipped(toolbelt);
  markProvisioned(stage, identity);
  return toolbelt;
}
