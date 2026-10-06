import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { RuntimeId } from "@bayma/core";
import { recordProvisionLookup } from "../telemetry/index.ts";

/**
 * A provisioned runtime: a directory that is copied verbatim into the payload,
 * plus the environment that points the runtime binary at it. Every path in
 * `envPaths` and `pathEnvPrepend` is relative to `root`; the payload manifest
 * carries them, and bayma resolves them at launch.
 */
export interface RuntimePayload {
  runtimeId: RuntimeId;
  root: string;
  /**
   * The payload directory `root` is copied to, when runtimes share one;
   * otherwise the runtime's id.
   */
  payloadDirectory?: string;
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
 * What one provisioner leaves in the work directory for the payload: a
 * directory, relative to the work directory, reused while its marker names
 * `identity`, the digests of the pins and sources it is built from.
 */
export interface Toolchain {
  name: string;
  directory: string;
  /** Other directories it leaves that tests build with, kept along with it. */
  alongside?: string[];
  identity(repoRoot: string): string;
  /** The platform's pins its provisioner reads. */
  pins: unknown;
  /** The module that provisions it. */
  module: string;
}

/**
 * Provisioners are idempotent: `identity` names the pins that produced a
 * directory, and a directory whose marker matches is reused as is.
 */
export function isProvisioned(
  context: ProvisionContext,
  directory: string,
  identity: string,
): boolean {
  const marker = join(directory, ".provisioned");
  const provisioned =
    existsSync(marker) && readFileSync(marker, "utf8").trim() === identity;
  recordProvisionLookup(relative(context.workDir, directory), provisioned);
  return provisioned;
}

export function resetDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export function markProvisioned(directory: string, identity: string): void {
  writeFileSync(join(directory, ".provisioned"), identity + "\n");
}
