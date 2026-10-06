import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  hostPlatformId,
  TOOLBELT_INSTALL_LOCK,
  toolbeltPath,
  type PathEnvironment,
  type PayloadManifest,
} from "@bayma/core";

/**
 * A payload on disk whose files exist, so path resolution can be exercised
 * and a server started from it, though none of its runtimes runs.
 */
export function writePayload(
  root: string,
  edit: (manifest: PayloadManifest) => void = () => undefined,
): string {
  const manifest: PayloadManifest = {
    schemaVersion: 1,
    version: "9.9.9",
    platform: hostPlatformId(),
    runtimes: {
      bun: {
        root: "bun",
        env: {},
        envPaths: { BAYMA_BUN_BIN: "bun" },
        pathEnvPrepend: { PATH: ["."] },
        pins: { version: "1.4.2" },
      },
      python: {
        root: "python",
        env: {},
        envPaths: { BAYMA_PYTHON_BIN: "bin/python3" },
        pathEnvPrepend: { PATH: ["bin"] },
        pins: {},
      },
      "dotnet-script": {
        root: "dotnet-script",
        env: {},
        envPaths: {
          DOTNET_ROOT: ".",
          BAYMA_DOTNET_ROOT: ".",
          BAYMA_DOTNET_SCRIPT_BIN: "tools/dotnet-script",
          BAYMA_DOTNET_SCRIPT_LIB_DIR: "lib",
        },
        pathEnvPrepend: { PATH: ["."] },
        pins: {},
      },
      rust: {
        root: "rust",
        env: { BAYMA_RUST_VERSION: "1.97.1" },
        envPaths: {
          BAYMA_RUST_HOST_BIN: "host/bayma-rust-host",
          BAYMA_RUSTC_BIN: "toolchain/bin/rustc",
          BAYMA_CARGO_BIN: "toolchain/bin/cargo",
          BAYMA_RUST_SUPPORT_DIR: "support",
          BAYMA_RUST_CARGO_SEED_DIR: "cargo-seed",
        },
        pathEnvPrepend: { PATH: ["toolchain/bin"] },
        pins: {},
      },
      // C and C++ share one host, in one payload directory.
      c: {
        root: "clang",
        env: {},
        envPaths: { BAYMA_C_HOST_BIN: "bin/bayma-cpp-host" },
        pathEnvPrepend: { PATH: ["bin"] },
        pins: {},
      },
      cpp: {
        root: "clang",
        env: {},
        envPaths: { BAYMA_CPP_HOST_BIN: "bin/bayma-cpp-host" },
        pathEnvPrepend: { PATH: ["bin"] },
        pins: {},
      },
      lean: {
        root: "lean",
        env: { BAYMA_LEAN_VERSION: "4.34.0" },
        envPaths: {
          BAYMA_LEAN_HOST_BIN: "bin/bayma-lean-host",
          BAYMA_LAKE_BIN: "bin/lake",
        },
        pathEnvPrepend: { PATH: ["bin"] },
        pins: {},
      },
      go: {
        root: "go",
        env: {},
        envPaths: {
          BAYMA_GO_HOST_BIN: "bin/bayma-go-host",
          BAYMA_GO_BIN: "go/bin/go",
          BAYMA_GO_CC: "bin/cc",
        },
        pathEnvPrepend: { PATH: ["go/bin"] },
        pins: {},
      },
    },
  };
  edit(manifest);
  for (const runtime of Object.values(manifest.runtimes)) {
    for (const entries of Object.values(runtime.pathEnvPrepend)) {
      for (const entry of entries)
        mkdirSync(join(root, runtime.root, entry), { recursive: true });
    }
    for (const relative of Object.values(runtime.envPaths)) {
      const path = join(root, runtime.root, relative);
      // A directory-valued path (a root) is made as one; a file is touched.
      if (relative === "." || relative.endsWith("/")) {
        mkdirSync(path, { recursive: true });
        continue;
      }
      mkdirSync(join(path, ".."), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, "");
    }
  }
  writeFileSync(
    join(root, "payload.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return root;
}

/**
 * Hold the lock beside `env`'s toolbelt path as a bayma installing the
 * toolbelt there holds it; the function returned lets go of it, as that
 * bayma's exit does.
 */
export function holdToolbeltInstallLock(env: PathEnvironment): () => void {
  mkdirSync(dirname(toolbeltPath(env)), { recursive: true });
  const lock = new Database(
    join(dirname(toolbeltPath(env)), TOOLBELT_INSTALL_LOCK),
  );
  lock.run("BEGIN EXCLUSIVE");
  return () => lock.close(true);
}
