import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GO, ZIG } from "../platforms.ts";
import { fetchPinned } from "../shared/download.ts";
import { copyTree, walkFiles } from "../shared/files.ts";
import { sha256File } from "../shared/hashing.ts";
import { runOrThrow } from "../shared/process.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
} from "./payload.ts";
import { provisionZig, zigTarget } from "./zig.ts";

// The Go payload: Go's release as it is, bayma-go-host built from this
// repository's sources with it, and, on Linux, the pinned zig as the C
// compiler every cell's plugin is built with, as the host was. macOS builds
// with the Command Line Tools' clang.

const NATIVE_DIR = join("packages", "runtime-go", "native");
const HOST = "bayma-go-host";

export async function provisionGo(
  context: ProvisionContext,
): Promise<RuntimePayload> {
  const root = join(context.workDir, "go", "payload");
  const native = join(context.repoRoot, NATIVE_DIR);
  const identity = [
    GO.sha256,
    ZIG?.sha256 ?? "no-zig",
    ...walkFiles(native).map(sha256File),
  ].join(":");
  if (!isProvisioned(context, root, identity)) {
    resetDirectory(root);
    mkdirSync(join(root, "bin"), { recursive: true });
    const archive = await fetchPinned(
      GO,
      context.downloadsDir,
      `Go ${GO.version}`,
    );
    // The release unpacks to go/, the toolchain's root.
    await runOrThrow(["tar", "-xzf", archive, "-C", root]);
    const version = (
      await runOrThrow([join(root, "go", "bin", "go"), "version"])
    ).stdout;
    if (!version.startsWith(`go version go${GO.version} `)) {
      throw new Error(`pinned Go reports ${version.trim()}`);
    }
    if (ZIG) {
      copyTree(await provisionZig(context, ZIG), join(root, "zig"));
      rmSync(join(root, "zig", ".provisioned"), { force: true });
      writeCompilerWrapper(join(root, "bin", "cc"));
    }
    await buildHost(context, root, native);
    markProvisioned(root, identity);
  }
  return {
    runtimeId: "go",
    root,
    env: {},
    envPaths: {
      BAYMA_GO_HOST_BIN: `bin/${HOST}`,
      BAYMA_GO_BIN: "go/bin/go",
      ...(ZIG ? { BAYMA_GO_CC: "bin/cc" } : {}),
    },
    pathEnvPrepend: { PATH: ["go/bin"] },
    pins: {
      version: GO.version,
      sha256: GO.sha256,
      url: GO.url,
      ...(ZIG ? { cc: `zig-${ZIG.zigVersion}` } : {}),
    },
  };
}

/** zig as `cc`, found beside the wrapper wherever the payload is. */
function writeCompilerWrapper(path: string): void {
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      "# Go builds plugins with cgo; zig compiles them against the glibc floor,",
      "# as it compiled the host.",
      `exec "$(dirname "$0")/../zig/zig" cc -target ${zigTarget()} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

/**
 * Builds the host with the payload's own Go and C compiler, as its cells'
 * plugins will be built, and runs the engine's tests, which build and load
 * plugins the same way.
 */
async function buildHost(
  context: ProvisionContext,
  root: string,
  native: string,
): Promise<void> {
  const work = join(context.workDir, "go");
  const env = {
    PATH: `${join(root, "go", "bin")}:${process.env.PATH ?? ""}`,
    GOROOT: undefined,
    GOPATH: join(work, "path"),
    GOCACHE: join(work, "cache"),
    GOENV: "off",
    GOTOOLCHAIN: "local",
    GOFLAGS: "-trimpath -modcacherw",
    CGO_ENABLED: "1",
    CC: ZIG ? join(root, "bin", "cc") : "cc",
    ZIG_GLOBAL_CACHE_DIR: join(work, "zig-cache"),
    ZIG_LOCAL_CACHE_DIR: join(work, "zig-cache"),
  };
  const go = join(root, "go", "bin", "go");
  await runOrThrow([go, "build", "-o", join(root, "bin", HOST), "."], {
    cwd: native,
    env,
  });
  await runOrThrow([go, "test", "-count=1", "./..."], { cwd: native, env });
}
