import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RUNTIME_IDS } from "@bayma/core";
import { packageManifest } from "./build.ts";
import { hostPlatformId, type PlatformId } from "./platforms.ts";
import type { ProvisionRecord } from "./provision/index.ts";
import { writeJson } from "./shared/files.ts";
import { sha256File } from "./shared/hashing.ts";
import { runOrThrow } from "./shared/process.ts";

// The payload: every toolchain bayma runs, assembled for one platform and
// tarred as the release asset an install downloads.

export const PAYLOAD_MANIFEST = "payload.json";
export const PAYLOAD_SCHEMA_VERSION = 1 as const;

export interface PayloadRuntime {
  /** Directory under the payload root, e.g. `python`. */
  root: string;
  env: Record<string, string>;
  /** Variable → path relative to the runtime's root. */
  envPaths: Record<string, string>;
  /** Variable → paths relative to the runtime's root, prepended in order. */
  pathEnvPrepend: Record<string, string[]>;
  pins: Record<string, string>;
}

export interface PayloadManifest {
  schemaVersion: typeof PAYLOAD_SCHEMA_VERSION;
  version: string;
  platform: PlatformId;
  runtimes: Record<string, PayloadRuntime>;
}

export interface PayloadResult {
  directory: string;
  tarball: string;
  sha256: string;
  bytes: number;
}

export function payloadTarballName(
  platform: PlatformId,
  version: string,
): string {
  return `bayma-payload-${platform}-${version}.tar.gz`;
}

/** Copy every provisioned runtime into one directory and describe it. */
export function assemblePayload(
  repoRoot: string,
  record: ProvisionRecord,
  outDir: string,
): PayloadResult {
  const { version } = packageManifest(repoRoot);
  const platform = hostPlatformId();
  const directory = join(outDir, "payload");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const runtimes: Record<string, PayloadRuntime> = {};
  for (const runtimeId of RUNTIME_IDS) {
    const provisioned = record.payloads[runtimeId];
    if (!provisioned)
      throw new Error(`no provisioned payload for ${runtimeId}`);
    // verbatimSymlinks: a payload's internal links must stay relative, or
    // they would point back at the machine that built it.
    cpSync(provisioned.root, join(directory, runtimeId), {
      recursive: true,
      verbatimSymlinks: true,
    });
    rmSync(join(directory, runtimeId, ".provisioned"), { force: true });
    runtimes[runtimeId] = {
      root: runtimeId,
      env: provisioned.env,
      envPaths: provisioned.envPaths,
      pathEnvPrepend: provisioned.pathEnvPrepend,
      pins: provisioned.pins,
    };
  }
  const manifest: PayloadManifest = {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    version,
    platform,
    runtimes,
  };
  writeJson(join(directory, PAYLOAD_MANIFEST), manifest);

  // One payload tarball per platform in dist: an older version's would
  // outlive its payload directory and confuse a release.
  for (const name of readdirSync(outDir)) {
    if (name.startsWith(`bayma-payload-${platform}-`)) {
      rmSync(join(outDir, name), { force: true });
    }
  }
  const tarball = join(outDir, payloadTarballName(platform, version));
  runOrThrow(["tar", "-czf", tarball, "-C", outDir, "payload"]);
  if (!existsSync(tarball))
    throw new Error(`payload tarball was not written to ${tarball}`);
  return {
    directory,
    tarball,
    sha256: sha256File(tarball),
    bytes: Bun.file(tarball).size,
  };
}
