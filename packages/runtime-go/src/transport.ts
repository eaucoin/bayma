import { join } from "node:path";
import {
  cacheRoot,
  claimScratchDirectory,
  payloadValue,
  ProcessTransport,
  type RuntimeTransport,
} from "@bayma/core";

export const GO_PROMPT = "BAYMA> ";

// The host builds its first cell before its prompt, and the first session on
// a machine compiles Go's standard library for plugins; a finite guard still
// reports a host that never becomes ready.
const GO_STARTUP_TIMEOUT_MS = 120_000;

export function createGoTransport(): RuntimeTransport {
  const scratch = claimScratchDirectory(join(cacheRoot(), "go", "scratch"));
  return new ProcessTransport({
    platformId: "stdio",
    promptRe: /(?:^|[\r\n])BAYMA> /g,
    // Nothing stops a goroutine from outside it.
    interruptStrategy: "recycle",
    // A cell's `go build` runs in the host's process group.
    ownsProcessTree: true,
    promptTimeoutMs: GO_STARTUP_TIMEOUT_MS,
    command: () => goHostCommand(scratch),
  });
}

/** The host, and how it runs: its sessions go under `scratch`. */
export function goHostCommand(scratch: string): {
  file: string;
  args: string[];
  env: Record<string, string>;
} {
  const root = join(cacheRoot(), "go");
  return {
    file: payloadValue("BAYMA_GO_HOST_BIN"),
    args: [],
    env: {
      BAYMA_GO_SCRATCH_DIR: scratch,
      GOPATH: join(root, "path"),
      GOCACHE: join(root, "build"),
      GOENV: "off",
      GOTOOLCHAIN: "local",
      // Plugins must be built as the host was, wherever the payload is.
      GOFLAGS: "-trimpath -modcacherw",
      CGO_ENABLED: "1",
      // The payload's C compiler on Linux; the Command Line Tools' on macOS.
      CC: process.env.BAYMA_GO_CC ?? "cc",
      ZIG_GLOBAL_CACHE_DIR: join(root, "zig"),
      ZIG_LOCAL_CACHE_DIR: join(root, "zig"),
    },
  };
}
