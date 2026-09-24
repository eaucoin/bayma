import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cacheRoot,
  claimScratchDirectory,
  payloadValue,
  ProcessTransport,
  type RuntimeCheckpointCodec,
  type RuntimeTransport,
} from "@bayma/core";

export const LEAN_PROMPT = "BAYMA> ";
export const LEAN_CHECKPOINT_CODEC = {
  codecId: "lean-environment-v1",
  codecVersion: 1,
  payloadKind: "binary-sidecar",
} as const satisfies RuntimeCheckpointCodec;

// A session in a Lake project starts through `lake env`, which may first
// resolve the project's workspace; a finite guard still reports a host that
// never becomes ready.
const LEAN_STARTUP_TIMEOUT_MS = 60_000;

export function createLeanTransport(): RuntimeTransport {
  const scratch = claimScratchDirectory(join(cacheRoot(), "lean", "scratch"));
  return new ProcessTransport({
    platformId: "stdio",
    promptRe: /(?:^|[\r\n])BAYMA> /g,
    // Nothing stops Lean's elaborator from outside it.
    interruptStrategy: "recycle",
    promptTimeoutMs: LEAN_STARTUP_TIMEOUT_MS,
    command: ({ cwd }) => leanHostCommand(cwd, scratch),
  });
}

/**
 * The host, and how it runs for a session in `cwd`: in a Lake project,
 * through `lake env`, which puts the project's built libraries on its search
 * path. What it restores goes under `scratch`.
 */
export function leanHostCommand(
  cwd: string,
  scratch: string,
): { file: string; args: string[]; env: Record<string, string> } {
  const host = payloadValue("BAYMA_LEAN_HOST_BIN");
  const env = { BAYMA_LEAN_SCRATCH_DIR: scratch };
  return isLakeProject(cwd)
    ? { file: payloadValue("BAYMA_LAKE_BIN"), args: ["env", host], env }
    : { file: host, args: [], env };
}

/**
 * Whether `cwd` is a Lake project, which must name, in its lean-toolchain,
 * the Lean this runtime runs: libraries built by another cannot be imported.
 */
function isLakeProject(cwd: string): boolean {
  if (!["lakefile.toml", "lakefile.lean"].some((f) => existsSync(join(cwd, f))))
    return false;
  const running = payloadValue("BAYMA_LEAN_VERSION");
  const toolchainFile = join(cwd, "lean-toolchain");
  const named = existsSync(toolchainFile)
    ? readFileSync(toolchainFile, "utf8").trim()
    : undefined;
  if (named?.replace(/^leanprover\/lean4:/, "").replace(/^v/, "") !== running) {
    throw new Error(
      `the Lake project in ${cwd} names ${named ?? "no Lean"} in its lean-toolchain; this runtime runs Lean ${running}`,
    );
  }
  return true;
}
