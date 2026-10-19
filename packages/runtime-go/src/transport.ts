import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cacheRoot,
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
  return new ProcessTransport({
    platformId: "stdio",
    promptRe: /(?:^|[\r\n])BAYMA> /g,
    // Nothing stops a goroutine from outside it.
    interruptStrategy: "recycle",
    startupTimeoutMs: GO_STARTUP_TIMEOUT_MS,
    command: ({ scratchDir }) => goHostCommand(scratchDir),
    endedHostFiles: goHostModules,
  });
}

/**
 * The modules the host of `pid` made in the scratch directory `scratch`, as
 * module.go names them, `<pid>-<random>`: what it leaves there once it ends,
 * each holding the plugins it mapped.
 */
export function goHostModules(scratch: string, pid: number): string[] {
  const modules = join(scratch, "go");
  let names: string[];
  try {
    names = readdirSync(modules);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.startsWith(`${pid}-`))
    .map((name) => join(modules, name));
}

/**
 * The host, and how it runs: its session's module goes under `scratch`, in a
 * directory of the Go hosts' own, where each host makes a module of its own
 * and removes none; the server removes a host's once the host has ended and
 * the state generation has moved on past its end (goHostModules), and all of
 * them as it closes the session, or starts afresh.
 */
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
      BAYMA_GO_SCRATCH_DIR: join(scratch, "go"),
      // The host is built -trimpath, so it knows no GOROOT of its own; cells
      // that read Go's own packages through go/build or go/importer find
      // them here.
      GOROOT: dirname(dirname(payloadValue("BAYMA_GO_BIN"))),
      GOPATH: join(root, "path"),
      GOCACHE: join(root, "build"),
      GOENV: "off",
      GOTOOLCHAIN: "local",
      // Plugins must be built as the host was, wherever the payload is.
      GOFLAGS: "-trimpath -modcacherw",
      CGO_ENABLED: "1",
      // The payload's C compiler.
      CC: payloadValue("BAYMA_GO_CC"),
      ZIG_GLOBAL_CACHE_DIR: join(root, "zig"),
      ZIG_LOCAL_CACHE_DIR: join(root, "zig"),
    },
  };
}
