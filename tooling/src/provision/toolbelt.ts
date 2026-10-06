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
import { fileURLToPath } from "node:url";
import { TOOLBELT_DIR, type RuntimeId } from "@bayma/core";
import { BUN, DOTNET, PYTHON, RUST, UV } from "../platforms.ts";
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
  type Toolchain,
} from "./payload.ts";

// The toolbelt: the repository's `toolbelt/` package with its Bun, Python,
// Rust, and C# dependencies installed from their lockfiles against the
// payload's own runtimes, proven by its tests, and stripped of them for the
// payload.

const SOURCE = "toolbelt";
const SKILL = join("skills", "bayma-runtime-python", "SKILL.md");
/**
 * What the payload does not carry: the tests that prove the toolbelt, and
 * what building and proving it leave behind.
 */
const NOT_SHIPPED = [
  "tests",
  "toolbelt.test.ts",
  "toolbelt.stress.test.ts",
  join("rust", "tests"),
  // The C# project restores and builds nothing of its own to ship.
  join("dotnet", "obj"),
  join("dotnet", "Toolbelt.dll"),
  join("dotnet", "Toolbelt.pdb"),
  join("dotnet", "Toolbelt.deps.json"),
  "build",
  "bayma_toolbelt.egg-info",
  ".ruff_cache",
];

/**
 * The stage the payload's toolbelt is built in. It is installed with, and its
 * tests prove it against, the payload's Bun, Python, .NET SDK, and Rust.
 */
export const TOOLBELT_TOOLCHAIN: Toolchain = {
  name: "toolbelt",
  directory: "toolbelt",
  identity: (repoRoot) =>
    [
      UV.sha256,
      BUN.sha256,
      PYTHON.sha256,
      DOTNET.sha256,
      sha256File(join(repoRoot, SKILL)),
      ...walkFiles(join(repoRoot, SOURCE)).map(sha256File),
    ].join(":"),
  pins: { UV, BUN, PYTHON, DOTNET, RUST },
  module: fileURLToPath(import.meta.url),
};

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

/**
 * The C# toolbelt: Roslyn's Workspaces assemblies, restored from the lockfile
 * with the payload's own SDK into the toolbelt's dotnet/ directory.
 */
async function buildDotnet(
  toolbelt: string,
  dotnetRoot: string,
  workDir: string,
): Promise<void> {
  const project = join(toolbelt, "dotnet");
  const dotnet = join(dotnetRoot, "dotnet");
  const env = {
    DOTNET_ROOT: dotnetRoot,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    NUGET_PACKAGES: join(workDir, "nuget"),
  };
  await runOrThrow([dotnet, "restore", "--locked-mode"], { cwd: project, env });
  await runOrThrow(
    [dotnet, "build", "--no-restore", "-c", "Release", "-o", project],
    { cwd: project, env },
  );
}

export async function provisionToolbelt(
  context: ProvisionContext,
  runtimes: Record<RuntimeId, RuntimePayload>,
): Promise<string> {
  const bun = runtimeFile(runtimes.bun, "BAYMA_BUN_BIN");
  const python = runtimeFile(runtimes.python, "BAYMA_PYTHON_BIN");
  const cargo = runtimeFile(runtimes.rust, "BAYMA_CARGO_BIN");
  const rustc = runtimeFile(runtimes.rust, "BAYMA_RUSTC_BIN");
  const seed = runtimeFile(runtimes.rust, "BAYMA_RUST_CARGO_SEED_DIR");
  const dotnetRoot = runtimeFile(
    runtimes["dotnet-script"],
    "BAYMA_DOTNET_ROOT",
  );
  const source = join(context.repoRoot, SOURCE);
  // The stage mirrors the payload: the toolbelt beside a `python` that is the
  // payload's interpreter, and the skill where the toolbelt's tests read it.
  const stage = join(context.workDir, TOOLBELT_TOOLCHAIN.directory);
  const toolbelt = join(stage, TOOLBELT_DIR);
  const identity = TOOLBELT_TOOLCHAIN.identity(context.repoRoot);
  if (isProvisioned(context, stage, identity)) return toolbelt;

  const uv = await provisionUv(context);
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
  await buildDotnet(toolbelt, dotnetRoot, context.workDir);

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
