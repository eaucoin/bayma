import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  hostPlatformId,
  payloadDir,
  readPayloadManifest,
  requirePayloadDir,
  resolvePayloadEnvironment,
  RUNTIME_IDS,
  TOOLBELT_DIR,
  toolbeltPath,
} from "@bayma/core";
import { writePayload } from "../../../support/payload.ts";
import { withTempDir } from "../../../support/temp.ts";

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

test("the payload BAYMA_PAYLOAD_DIR names is required to hold one", async () => {
  await withTempDir((dir) => {
    const root = writePayload(join(dir, "payload"));
    mkdirSync(join(root, TOOLBELT_DIR));
    const env = {
      BAYMA_PAYLOAD_DIR: root,
      XDG_DATA_HOME: join(dir, "data"),
    };

    expect(requirePayloadDir(env)).toBe(root);
    // The toolbelt is installed by whoever needs it, in the background or not.
    expect(existsSync(toolbeltPath(env))).toBe(false);
    expect(() =>
      requirePayloadDir({ BAYMA_PAYLOAD_DIR: join(dir, "empty") }),
    ).toThrow(`BAYMA_PAYLOAD_DIR holds no payload.json: ${join(dir, "empty")}`);
  });
});
