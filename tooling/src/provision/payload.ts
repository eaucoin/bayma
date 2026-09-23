import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeId } from "@bayma/core";

/**
 * A provisioned runtime: a directory that is copied verbatim into the package
 * as `payloads/<runtimeId>`, plus the environment that points the runtime
 * binary at it. Every path in `envPaths` and `pathEnvPrepend` is relative to
 * `root`; `runtime-environment.cjs` resolves them at launch.
 */
export interface RuntimePayload {
  runtimeId: RuntimeId;
  root: string;
  env: Record<string, string>;
  envPaths: Record<string, string>;
  pathEnvPrepend: Record<string, string[]>;
  /** What was pinned: versions and digests, for `provision.json`. */
  pins: Record<string, string>;
}

export interface ProvisionContext {
  workDir: string;
  downloadsDir: string;
  repoRoot: string;
}

/**
 * Provisioners are idempotent: `identity` names the pins that produced a
 * directory, and a directory whose marker matches is reused as is.
 */
export function isProvisioned(directory: string, identity: string): boolean {
  const marker = join(directory, ".provisioned");
  return existsSync(marker) && readFileSync(marker, "utf8").trim() === identity;
}

export function resetDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export function markProvisioned(directory: string, identity: string): void {
  writeFileSync(join(directory, ".provisioned"), identity + "\n");
}
