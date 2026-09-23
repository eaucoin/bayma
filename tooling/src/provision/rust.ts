import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PLATFORM, RUST } from "../platforms.ts";

/** Where the Rust host, its support crate, and the patched EVcxR live. */
const NATIVE_DIR = join("packages", "runtime-rust", "native");
import { fetchPinned } from "../shared/download.ts";
import { copyTree, ensureDir, walkFiles } from "../shared/files.ts";
import { sha256File } from "../shared/hashing.ts";
import { runOrThrow } from "../shared/process.ts";
import { writeLicenseEvidence } from "../rust-licenses.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
} from "./payload.ts";

// The Rust payload: a pinned toolchain (rustc, cargo, std), the
// bayma-rust-host binary built from the sources this repository ships, the
// support crate every cell links, a verified Cargo registry seed for that
// crate's dependencies, and the licence inventory.

const TOOLCHAIN_IDENTITY = Object.values(RUST.components)
  .map((component) => component.sha256)
  .join(":");

async function provisionToolchain(context: ProvisionContext): Promise<string> {
  const directory = join(context.workDir, "rust", "toolchain");
  if (isProvisioned(directory, TOOLCHAIN_IDENTITY)) return directory;
  resetDirectory(directory);
  mkdirSync(directory, { recursive: true });
  await assertChannelManifest(context);
  for (const [role, component] of Object.entries(RUST.components)) {
    const archive = await fetchPinned(
      component,
      context.downloadsDir,
      `Rust ${role}`,
    );
    const staging = mkdtempSync(join(tmpdir(), `bayma-rust-${role}-`));
    try {
      runOrThrow([
        "tar",
        "-xJf",
        archive,
        "-C",
        staging,
        "--strip-components=1",
      ]);
      runOrThrow([
        "sh",
        join(staging, "install.sh"),
        `--prefix=${directory}`,
        "--disable-ldconfig",
      ]);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const rustc = runOrThrow([
    join(directory, "bin", "rustc"),
    "--version",
  ]).stdout;
  if (!rustc.startsWith(`rustc ${RUST.version} `)) {
    throw new Error(`pinned toolchain reports ${rustc.trim()}`);
  }
  markProvisioned(directory, TOOLCHAIN_IDENTITY);
  return directory;
}

/** The dated channel manifest must agree with every pinned component. */
async function assertChannelManifest(context: ProvisionContext): Promise<void> {
  const path = await fetchPinned(
    RUST.channelManifest,
    context.downloadsDir,
    "Rust channel manifest",
  );
  const manifest = Bun.TOML.parse(readFileSync(path, "utf8")) as {
    "manifest-version"?: string;
    date?: string;
    pkg?: Record<
      string,
      {
        version?: string;
        target?: Record<string, { xz_url?: string; xz_hash?: string }>;
      }
    >;
  };
  if (
    manifest["manifest-version"] !== "2" ||
    manifest.date !== RUST.distDate ||
    !manifest.pkg?.rustc?.version?.startsWith(`${RUST.version} (`)
  ) {
    throw new Error("Rust channel manifest disagrees with the pinned version");
  }
  for (const [role, component] of Object.entries(RUST.components)) {
    const entry = manifest.pkg[role]?.target?.[RUST.target];
    if (entry?.xz_url !== component.url || entry.xz_hash !== component.sha256) {
      throw new Error(
        `Rust channel manifest disagrees with the pinned ${role}`,
      );
    }
  }
}

/**
 * zig as the C linker, with the host's shared libgcc_s as the unwinder, so
 * the host's glibc floor is the pin rather than the build machine's. Only
 * Linux needs one; macOS links with Apple's clang.
 */
async function provisionLinker(
  context: ProvisionContext,
): Promise<string | undefined> {
  const pinned = RUST.linker;
  if (!pinned) return undefined;
  const directory = join(context.workDir, "rust", "linker");
  const wrapper = join(directory, "cc");
  if (isProvisioned(directory, pinned.sha256)) return wrapper;
  resetDirectory(directory);
  mkdirSync(join(directory, "zig"), { recursive: true });
  const archive = await fetchPinned(pinned, context.downloadsDir, "zig");
  runOrThrow([
    "tar",
    "-xJf",
    archive,
    "-C",
    join(directory, "zig"),
    "--strip-components=1",
  ]);
  const version = runOrThrow([
    join(directory, "zig", "zig"),
    "version",
  ]).stdout.trim();
  if (version !== pinned.zigVersion) throw new Error(`zig reports ${version}`);
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      "# Every Rust binary and dylib must share one unwinder for panics to",
      "# propagate across the evcxr cell boundary, so -lgcc_s resolves to the",
      "# system's shared libgcc_s rather than zig's bundled static libunwind.",
      "# Arguments are rebuilt in place: no eval, so $ORIGIN in an rpath survives.",
      "count=$#",
      'while [ "$count" -gt 0 ]; do',
      "  arg=$1",
      "  shift",
      '  case "$arg" in -lgcc_s) arg=/lib/x86_64-linux-gnu/libgcc_s.so.1 ;; esac',
      '  set -- "$@" "$arg"',
      "  count=$((count - 1))",
      "done",
      `exec ${JSON.stringify(join(directory, "zig", "zig"))} cc -target ${PLATFORM.rustTarget.replace("unknown-", "")}.${pinned.glibcFloor} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  markProvisioned(directory, pinned.sha256);
  return wrapper;
}

function buildHost(
  context: ProvisionContext,
  toolchain: string,
  linker: string | undefined,
  targetDir: string,
): string {
  const host = join(targetDir, RUST.target, "release", "bayma-rust-host");
  const env = {
    RUSTC: join(toolchain, "bin", "rustc"),
    PATH: `${join(toolchain, "bin")}:${process.env.PATH ?? ""}`,
    CARGO_HOME: join(context.workDir, "rust", "cargo-home"),
    CARGO_ENCODED_RUSTFLAGS: undefined,
    RUSTFLAGS: "",
    ...(linker
      ? {
          [`CARGO_TARGET_${RUST.target.replaceAll("-", "_").toUpperCase()}_LINKER`]:
            linker,
          ZIG_GLOBAL_CACHE_DIR: join(context.workDir, "rust", "zig-cache"),
          ZIG_LOCAL_CACHE_DIR: join(context.workDir, "rust", "zig-cache"),
        }
      : {}),
  };
  runOrThrow(
    [
      join(toolchain, "bin", "cargo"),
      "build",
      "--manifest-path",
      join(context.repoRoot, NATIVE_DIR, "Cargo.toml"),
      "--locked",
      "--release",
      "--target",
      RUST.target,
      "--target-dir",
      targetDir,
      "-p",
      "bayma-rust-host",
    ],
    { cwd: context.repoRoot, env },
  );
  if (!existsSync(host))
    throw new Error(`bayma-rust-host was not built at ${host}`);
  // The patched evcxr carries bayma's content-addressed compilation cache;
  // its own tests are the proof that the patch still holds.
  runOrThrow(
    [
      join(toolchain, "bin", "cargo"),
      "test",
      "--manifest-path",
      join(context.repoRoot, NATIVE_DIR, "Cargo.toml"),
      "--locked",
      "--release",
      "--target",
      RUST.target,
      "--target-dir",
      targetDir,
      "-p",
      "evcxr",
      "--lib",
      "module::cache::tests::",
    ],
    { cwd: context.repoRoot, env },
  );
  return host;
}

/**
 * Fetch the support crate's dependencies into a fresh Cargo home and prove
 * every archive matches the reviewed lock, so cells compile offline.
 */
function buildCargoSeed(
  context: ProvisionContext,
  toolchain: string,
  destination: string,
): void {
  const lockSource = join(
    context.repoRoot,
    "tooling",
    "assets",
    "rust-support-seed.Cargo.lock",
  );
  const lockSha256 = sha256File(lockSource);
  if (lockSha256 !== RUST.supportSeedLockSha256) {
    throw new Error(
      `support seed lock ${lockSha256} does not match its reviewed identity`,
    );
  }
  const scratch = mkdtempSync(join(tmpdir(), "bayma-cargo-seed-"));
  try {
    const project = join(scratch, "project");
    const home = join(scratch, "home");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(
      join(project, "Cargo.toml"),
      [
        "[package]",
        'name = "bayma-rust-support-seed"',
        'version = "0.0.0"',
        'edition = "2024"',
        "",
        "[dependencies]",
        'serde = { version = "=1.0.228", features = ["derive"] }',
        'serde_json = "=1.0.145"',
        "",
      ].join("\n"),
    );
    writeFileSync(join(project, "src", "lib.rs"), "// dependency seed\n");
    copyFileSync(lockSource, join(project, "Cargo.lock"));
    runOrThrow([join(toolchain, "bin", "cargo"), "fetch", "--locked"], {
      cwd: project,
      env: { CARGO_HOME: home, RUSTC: join(toolchain, "bin", "rustc") },
    });
    verifyCargoSeed(home, join(project, "Cargo.lock"));
    writeFileSync(join(home, "bayma-seed-id"), lockSha256 + "\n");
    copyFileSync(lockSource, join(home, "bayma-support.Cargo.lock"));
    rmSync(destination, { recursive: true, force: true });
    cpSync(home, destination, { recursive: true });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function verifyCargoSeed(cargoHome: string, lockPath: string): void {
  const lock = Bun.TOML.parse(readFileSync(lockPath, "utf8")) as {
    version?: number;
    package?: Array<{
      name?: string;
      version?: string;
      source?: string;
      checksum?: string;
    }>;
  };
  if (lock.version !== 4 || !Array.isArray(lock.package)) {
    throw new Error("support seed lock has an unsupported shape");
  }
  const expected = new Map<string, string>(
    lock.package
      .filter((entry) => entry.source !== undefined)
      .map((entry) => {
        if (
          entry.source !==
            "registry+https://github.com/rust-lang/crates.io-index" ||
          !/^[0-9a-f]{64}$/.test(entry.checksum ?? "")
        ) {
          throw new Error(
            `support seed lock entry ${entry.name} has invalid registry metadata`,
          );
        }
        return [`${entry.name}-${entry.version}.crate`, entry.checksum!];
      }),
  );
  const archives = walkFiles(join(cargoHome, "registry", "cache")).filter(
    (path) => path.endsWith(".crate"),
  );
  if (archives.length !== expected.size) {
    throw new Error(
      `support seed has ${archives.length} archives, lock expects ${expected.size}`,
    );
  }
  for (const path of archives) {
    const checksum = expected.get(basename(path));
    if (!checksum)
      throw new Error(
        `support seed archive ${basename(path)} is not in the lock`,
      );
    const actual = sha256File(path);
    if (actual !== checksum)
      throw new Error(
        `support seed archive ${basename(path)} checksum ${actual} != ${checksum}`,
      );
  }
}

export async function provisionRust(
  context: ProvisionContext,
): Promise<RuntimePayload> {
  const toolchain = await provisionToolchain(context);
  const linker = await provisionLinker(context);
  const root = join(context.workDir, "rust", "payload");
  const supportSource = join(
    context.repoRoot,
    NATIVE_DIR,
    "bayma-rust-support",
  );
  const identity = [
    TOOLCHAIN_IDENTITY,
    RUST.linker?.sha256 ?? "no-linker",
    RUST.supportSeedLockSha256,
    sha256File(join(context.repoRoot, NATIVE_DIR, "Cargo.lock")),
    ...walkFiles(
      join(context.repoRoot, NATIVE_DIR, "bayma-rust-host", "src"),
    ).map(sha256File),
    // The host is built from these EVcxR sources too.
    ...walkFiles(join(context.repoRoot, NATIVE_DIR, "evcxr")).map(sha256File),
    ...walkFiles(supportSource).map(sha256File),
  ].join(":");
  if (!isProvisioned(root, identity)) {
    resetDirectory(root);
    ensureDir(join(root, "host"));
    copyTree(toolchain, join(root, "toolchain"));
    rmSync(join(root, "toolchain", ".provisioned"), { force: true });
    const targetDir = join(context.workDir, "rust", "host-target");
    copyFileSync(
      buildHost(context, toolchain, linker, targetDir),
      join(root, "host", "bayma-rust-host"),
    );
    chmodSync(join(root, "host", "bayma-rust-host"), 0o755);
    // Several hundred megabytes of intermediates; the payload identity covers
    // the sources, so a rebuild happens only when they change.
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(join(context.workDir, "rust", "zig-cache"), {
      recursive: true,
      force: true,
    });
    cpSync(supportSource, join(root, "support"), { recursive: true });
    buildCargoSeed(context, toolchain, join(root, "cargo-seed"));
    writeLicenseEvidence(
      join(root, "licenses"),
      join(context.repoRoot, NATIVE_DIR),
      "bayma-rust-host",
      join(toolchain, "bin", "cargo"),
    );
    markProvisioned(root, identity);
  }
  return {
    runtimeId: "rust",
    root,
    env: { BAYMA_RUST_VERSION: RUST.version },
    envPaths: {
      BAYMA_RUST_HOST_BIN: "host/bayma-rust-host",
      BAYMA_RUSTC_BIN: "toolchain/bin/rustc",
      BAYMA_CARGO_BIN: "toolchain/bin/cargo",
      BAYMA_RUST_SUPPORT_DIR: "support",
      BAYMA_RUST_CARGO_SEED_DIR: "cargo-seed",
    },
    pathEnvPrepend: { PATH: ["toolchain/bin", "host"] },
    pins: {
      version: RUST.version,
      distDate: RUST.distDate,
      target: RUST.target,
      evcxrVersion: RUST.evcxrVersion,
      ...(RUST.linker ? { linker: `zig-${RUST.linker.zigVersion}` } : {}),
      supportSeedLockSha256: RUST.supportSeedLockSha256,
      ...Object.fromEntries(
        Object.entries(RUST.components).map(([role, c]) => [
          `${role}Sha256`,
          c.sha256,
        ]),
      ),
    },
  };
}
