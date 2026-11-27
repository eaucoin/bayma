import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("the environment is resolved looking at none of a runtime's own files: a payload missing them resolves, each where the manifest names it", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(writePayload(dir));
    for (const missing of [
      join("lean", "bin", "bayma-lean-host"),
      join("go", "go", "bin", "go"),
      join("rust", "toolchain", "bin", "cargo"),
      join("clang", "bin", "bayma-cpp-host"),
    ])
      rmSync(join(root, missing));
    const env = resolvePayloadEnvironment(root, { PATH: "/usr/bin" });
    expect(env.BAYMA_LEAN_HOST_BIN).toBe(
      join(root, "lean", "bin", "bayma-lean-host"),
    );
    expect(env.BAYMA_GO_BIN).toBe(join(root, "go", "go", "bin", "go"));
    expect(env.BAYMA_CARGO_BIN).toBe(
      join(root, "rust", "toolchain", "bin", "cargo"),
    );
    expect(env.BAYMA_CPP_HOST_BIN).toBe(
      join(root, "clang", "bin", "bayma-cpp-host"),
    );
  });
});

test("a runtime's own files are looked at as the first of its sessions starts, once: each is given as it physically is, and one missing, or resolving outside the payload, is refused", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(writePayload(join(dir, "payload")));
    // Bun's binary a link to the file it is, inside the payload; Go's host
    // one a link to a file outside it; Lean's host missing.
    const bun = join(root, "bun", "bun-1.4.2");
    rmSync(join(root, "bun", "bun"));
    writeFileSync(bun, "");
    symlinkSync("bun-1.4.2", join(root, "bun", "bun"));
    writeFileSync(join(dir, "elsewhere"), "");
    rmSync(join(root, "go", "bin", "bayma-go-host"));
    symlinkSync(
      join(dir, "elsewhere"),
      join(root, "go", "bin", "bayma-go-host"),
    );
    const lean = join(root, "lean", "bin", "bayma-lean-host");
    rmSync(lean);
    mkdirSync(join(dir, "state"));
    // Applying a payload changes the process's environment, and what its
    // sessions' starts look at: in a process of its own.
    const ran = Bun.spawnSync(
      [
        process.execPath,
        join(
          import.meta.dir,
          "..",
          "..",
          "..",
          "support",
          "payload-runtime-command.ts",
        ),
        root,
        join(dir, "state"),
        "env:BAYMA_BUN_BIN",
        "create:bun",
        "env:BAYMA_BUN_BIN",
        `rm:${bun}`,
        // Once: the next session's start looks at nothing.
        "create:bun",
        "prepare:lean",
        "prepare:go",
        // A runtime refused is looked at again as it next runs.
        `touch:${lean}`,
        "prepare:lean",
        "env:BAYMA_LEAN_HOST_BIN",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(ran.stderr.toString()).toBe("");
    expect(
      ran.stdout
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      join(root, "bun", "bun"),
      { starts: 1 },
      bun,
      "ok",
      { starts: 2 },
      {
        error:
          "invalid bayma payload: lean.envPaths.BAYMA_LEAN_HOST_BIN does not exist in the payload",
        starts: 2,
      },
      {
        error:
          "invalid bayma payload: go.envPaths.BAYMA_GO_HOST_BIN resolves outside the payload root",
        starts: 2,
      },
      "ok",
      "ok",
      lean,
    ]);
  });
});

test("a session of a runtime whose files are not in the payload is refused, with the payload's refusal, before its runtime starts", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(writePayload(join(dir, "payload")));
    rmSync(join(root, "bun", "bun"));
    mkdirSync(join(dir, "state"));
    const ran = Bun.spawnSync(
      [
        process.execPath,
        join(
          import.meta.dir,
          "..",
          "..",
          "..",
          "support",
          "payload-runtime-command.ts",
        ),
        root,
        join(dir, "state"),
        "create:bun",
        `touch:${join(root, "bun", "bun")}`,
        "create:bun",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(ran.stderr.toString()).toBe("");
    expect(
      ran.stdout
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        error:
          "invalid bayma payload: bun.envPaths.BAYMA_BUN_BIN does not exist in the payload",
        starts: 0,
      },
      "ok",
      { starts: 1 },
    ]);
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
