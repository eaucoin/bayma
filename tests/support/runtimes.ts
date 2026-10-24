import { existsSync } from "node:fs";
import { resolve } from "node:path";

export { RUNTIME_IDS, type RuntimeId } from "@bayma/core";

// Timeouts shared by every test that launches a real runtime. dotnet-script
// and the Rust host compile on first start, so their settle budgets are long.
export const EXEC_SETTLE_TIMEOUT_MS = 90_000;
export const RUNTIME_CONTRACT_TEST_TIMEOUT_MS = 240_000;
export const MCP_REQUEST_TIMEOUT_MS = 90_000;
export const MCP_RESOURCE_TIMEOUT_MS = 5_000;

export interface LaunchSpec {
  command: string;
  args: string[];
  binaryLabel: string;
}

const repoRoot = resolve(import.meta.dir, "..", "..");
const ENTRYPOINT = resolve(repoRoot, "packages", "server", "src", "main.ts");

/** bayma runs under Node; tests never run the server under the test runner. */
export function nodeExecutable(): string {
  const node = process.env.BAYMA_TEST_NODE ?? Bun.which("node");
  if (!node) throw new Error("node is required on PATH to run bayma");
  return node;
}

/**
 * `BAYMA_BUNDLE` names a built dist/bayma.js; otherwise Node runs the source
 * entrypoint, stripping types itself.
 */
export function launchSpec(): LaunchSpec {
  const bundle = process.env.BAYMA_BUNDLE;
  const script = bundle ? resolve(bundle) : ENTRYPOINT;
  return {
    command: nodeExecutable(),
    args: [
      "--disable-warning=ExperimentalWarning",
      ...(bundle ? [] : ["--experimental-strip-types"]),
      script,
    ],
    binaryLabel: script,
  };
}

/**
 * Runs `bayma sandbox-hook` for the server of `stateDir`, unless none is
 * named, as gVisor runs it, with its mode in the environment, or else named
 * first, and the variables `env` beside. Returns how it exited, and its
 * stderr.
 */
export async function runSandboxHookCommand(
  stateDir: string | undefined,
  mode: string,
  modeIn: "environment" | "arguments" = "environment",
  env: Readonly<Record<string, string>> = {},
): Promise<{ status: number; stderr: string }> {
  const launch = launchSpec();
  const child = Bun.spawn(
    [
      launch.command,
      ...launch.args,
      "sandbox-hook",
      ...(modeIn === "arguments" ? [mode] : []),
      ...(stateDir === undefined ? [] : ["--state-dir", stateDir]),
    ],
    {
      env:
        modeIn === "environment"
          ? { ...process.env, ...env, GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE: mode }
          : { ...process.env, ...env },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const [status, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { status, stderr };
}

/** The bundle e2e tests exercise: `BAYMA_BUNDLE`, else dist/bayma.js. */
export function bundlePath(): string {
  const path = resolve(
    process.env.BAYMA_BUNDLE ?? resolve(repoRoot, "dist", "bayma.js"),
  );
  if (!existsSync(path))
    throw new Error(`bundle ${path} is missing; run bun run build`);
  return path;
}
