import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where bayma keeps things on a machine. Both roots follow the XDG base
 * directory convention on Linux and macOS alike, as developer tools do.
 *
 * - state: session catalogs, execution history, checkpoints. One directory
 *   per launch directory, so a client started from a project sees that
 *   project's sessions without bayma writing into the project.
 * - cache: materialised harness scripts, compiled Rust hosts, EVcxR's
 *   compilation cache. Safe to delete at any time.
 */

const PRODUCT = "bayma";

export type PathEnvironment = Readonly<Record<string, string | undefined>>;

function xdgRoot(
  env: PathEnvironment,
  variable: string,
  fallback: readonly string[],
): string {
  const configured = env[variable];
  return configured
    ? join(configured, PRODUCT)
    : join(env.HOME || homedir(), ...fallback, PRODUCT);
}

export function stateRoot(env: PathEnvironment = process.env): string {
  return xdgRoot(env, "XDG_STATE_HOME", [".local", "state"]);
}

export function cacheRoot(env: PathEnvironment = process.env): string {
  return env.BAYMA_CACHE_DIR || xdgRoot(env, "XDG_CACHE_HOME", [".cache"]);
}

/** The state directory for a server launched from `cwd`, unless one is named. */
export function defaultStateDir(
  cwd: string,
  env: PathEnvironment = process.env,
): string {
  if (env.BAYMA_STATE_DIR) return env.BAYMA_STATE_DIR;
  const key = createHash("sha256")
    .update(resolve(cwd))
    .digest("hex")
    .slice(0, 16);
  return join(stateRoot(env), key);
}
