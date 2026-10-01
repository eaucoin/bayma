import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  hostPlatformId,
  payloadDir,
  preparePayload,
  readPayloadManifest,
  resolvePayloadEnvironment,
  RUNTIME_IDS,
  TOOLBELT_DIR,
  TOOLBELT_VERSION_FILE,
  toolbeltPath,
  type PayloadManifest,
} from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

/** A payload on disk whose files exist, so path resolution can be exercised. */
function writePayload(
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
        pins: { version: "1.3.14" },
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

test("the manifest describes exactly the runtimes bayma hosts", async () => {
  await withTempDir(async (dir) => {
    const manifest = readPayloadManifest(writePayload(dir));
    expect(Object.keys(manifest.runtimes).sort()).toEqual(
      [...RUNTIME_IDS].sort(),
    );
    expect(manifest.platform).toBe(hostPlatformId());
  });
});

test("the resolved environment points every runtime at the payload", async () => {
  await withTempDir(async (dir) => {
    // realpath: the resolver reports physical paths, and a temporary
    // directory may be reached through a symlink.
    const root = realpathSync(writePayload(dir));
    const env = resolvePayloadEnvironment(root, {
      PATH: "/usr/bin",
      HOME: "/home/someone",
      // A host that tries to redirect a bundled runtime is ignored.
      PYTHONHOME: "/opt/python",
      LD_LIBRARY_PATH: "/opt/lib",
      CARGO_HOME: "/opt/cargo",
      RUSTUP_TOOLCHAIN: "nightly",
      BAYMA_BUN_BIN: "/usr/local/bin/bun",
      GOROOT: "/usr/local/go",
      GOFLAGS: "-mod=vendor",
      LEAN_PATH: "/opt/lean/lib",
      ELAN_TOOLCHAIN: "nightly",
    });
    expect(env.BAYMA_BUN_BIN).toBe(join(root, "bun", "bun"));
    expect(env.BAYMA_PYTHON_BIN).toBe(join(root, "python", "bin", "python3"));
    // Nothing that would redirect another Python a session starts.
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.PYTHONNOUSERSITE).toBeUndefined();
    expect(env.LD_LIBRARY_PATH).toBe("/opt/lib");
    expect(env.BAYMA_RUST_HOST_BIN).toBe(
      join(root, "rust", "host", "bayma-rust-host"),
    );
    expect(env.BAYMA_C_HOST_BIN).toBe(
      join(root, "clang", "bin", "bayma-cpp-host"),
    );
    expect(env.BAYMA_CPP_HOST_BIN).toBe(env.BAYMA_C_HOST_BIN);
    expect(env.BAYMA_LEAN_HOST_BIN).toBe(
      join(root, "lean", "bin", "bayma-lean-host"),
    );
    expect(env.BAYMA_LEAN_VERSION).toBe("4.34.0");
    expect(env.BAYMA_GO_HOST_BIN).toBe(
      join(root, "go", "bin", "bayma-go-host"),
    );
    for (const redirect of [
      "CARGO_HOME",
      "RUSTUP_TOOLCHAIN",
      "GOROOT",
      "GOFLAGS",
      "LEAN_PATH",
      "ELAN_TOOLCHAIN",
    ])
      expect(env[redirect]).toBeUndefined();
    expect(env.HOME).toBe("/home/someone");
    // Payload directories precede the host's own, in manifest order.
    expect(env.PATH.split(":")).toEqual([
      join(root, "bun"),
      join(root, "python", "bin"),
      join(root, "dotnet-script"),
      join(root, "rust", "toolchain", "bin"),
      join(root, "clang", "bin"),
      join(root, "lean", "bin"),
      join(root, "go", "go", "bin"),
      "/usr/bin",
    ]);
  });
});

test("the resolved environment leaves bayma's telemetry settings out", async () => {
  await withTempDir(async (dir) => {
    const env = resolvePayloadEnvironment(realpathSync(writePayload(dir)), {
      PATH: "/usr/bin",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20secret",
      TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      TRACESTATE: "vendor=value",
    });
    expect(
      Object.keys(env).filter((name) =>
        /^(OTEL_|TRACEPARENT$|TRACESTATE$)/.test(name),
      ),
    ).toEqual([]);
  });
});

test("a manifest path that escapes the payload is refused", async () => {
  await withTempDir(async (dir) => {
    const root = writePayload(dir, (manifest) => {
      manifest.runtimes.bun.envPaths.BAYMA_BUN_BIN = "../python/bin/python3";
    });
    expect(() => resolvePayloadEnvironment(root, {})).toThrow(
      "escapes the payload root",
    );
  });
});

test("two runtimes claiming one variable is refused", async () => {
  await withTempDir(async (dir) => {
    const root = writePayload(dir, (manifest) => {
      manifest.runtimes.python.env.BAYMA_RUST_VERSION = "1.0.0";
    });
    expect(() => resolvePayloadEnvironment(root, {})).toThrow(
      "assigned by both",
    );
  });
});

test("an incomplete manifest is refused", async () => {
  await withTempDir(async (dir) => {
    const root = writePayload(dir, (manifest) => {
      delete manifest.runtimes.rust.envPaths.BAYMA_RUST_SUPPORT_DIR;
    });
    expect(() => readPayloadManifest(root)).toThrow(
      "rust.envPaths omits BAYMA_RUST_SUPPORT_DIR",
    );
  });
});

test("the payload is the one BAYMA_PAYLOAD_DIR names, and there is none without it", () => {
  expect(payloadDir({ BAYMA_PAYLOAD_DIR: "/opt/bayma/payload" })).toBe(
    "/opt/bayma/payload",
  );
  expect(() => payloadDir({ HOME: "/home/someone" })).toThrow(
    "BAYMA_PAYLOAD_DIR is not set",
  );
});

test("preparing the payload installs its toolbelt", async () => {
  await withTempDir((dir) => {
    const root = writePayload(join(dir, "payload"));
    mkdirSync(join(root, TOOLBELT_DIR));
    const env = {
      BAYMA_PAYLOAD_DIR: root,
      XDG_DATA_HOME: join(dir, "data"),
    };
    const reports: string[] = [];

    expect(preparePayload(env, (message) => reports.push(message))).toBe(root);

    expect(
      readFileSync(join(toolbeltPath(env), TOOLBELT_VERSION_FILE), "utf8"),
    ).toBe("9.9.9\n");
    expect(reports).toEqual([
      `bayma: installed the 9.9.9 toolbelt at ${toolbeltPath(env)}`,
    ]);
  });
});

test("a BAYMA_PAYLOAD_DIR that holds no payload is refused", async () => {
  await withTempDir((dir) => {
    const env = {
      BAYMA_PAYLOAD_DIR: join(dir, "empty"),
      XDG_DATA_HOME: join(dir, "data"),
    };

    expect(() => preparePayload(env)).toThrow(
      `BAYMA_PAYLOAD_DIR holds no payload.json: ${join(dir, "empty")}`,
    );
    expect(existsSync(toolbeltPath(env))).toBe(false);
  });
});
