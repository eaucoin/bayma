import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { bindToolbelt, RUNTIME_IDS, TOOLBELT_DIR } from "@bayma/core";
import { packageManifest } from "./build.ts";
import { hostPlatformId, type PlatformId } from "./platforms.ts";
import type { ProvisionRecord } from "./provision/index.ts";
import { treeBytes, writeJson } from "./shared/files.ts";
import { recordArtifact, telemetryEnabled } from "./telemetry/index.ts";

// The payload: every toolchain bayma runs and the toolbelt built against
// them, assembled into the one directory bayma's image carries.

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

/**
 * Let whoever runs the payload use it: bayma's image runs as the user who
 * starts it, so every file is readable by anyone, and every directory and
 * program usable by anyone.
 */
function openToEveryone(directory: string): void {
  const paths = [
    directory,
    ...readdirSync(directory, { recursive: true, encoding: "utf8" }).map(
      (path) => join(directory, path),
    ),
  ];
  for (const path of paths) {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) continue;
    const usable = entry.isDirectory() || entry.mode & 0o100 ? 0o555 : 0o444;
    chmodSync(path, (entry.mode & 0o7777) | usable);
  }
}

/**
 * Copy every provisioned runtime and the toolbelt into one directory and
 * describe it; returns the directory.
 */
export function assemblePayload(
  repoRoot: string,
  record: ProvisionRecord,
  outDir: string,
): string {
  const { version } = packageManifest(repoRoot);
  const platform = hostPlatformId();
  const directory = join(outDir, "payload");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const runtimes: Record<string, PayloadRuntime> = {};
  // Payload directory → the provisioned tree placed there.
  const placed = new Map<string, string>();
  for (const runtimeId of RUNTIME_IDS) {
    const provisioned = record.payloads[runtimeId];
    if (!provisioned)
      throw new Error(`no provisioned payload for ${runtimeId}`);
    const name = provisioned.payloadDirectory ?? runtimeId;
    const source = placed.get(name);
    if (source === undefined) {
      // verbatimSymlinks: a payload's internal links must stay relative, or
      // they would point back at the machine that built it.
      cpSync(provisioned.root, join(directory, name), {
        recursive: true,
        verbatimSymlinks: true,
      });
      rmSync(join(directory, name, ".provisioned"), { force: true });
      placed.set(name, provisioned.root);
    } else if (source !== provisioned.root) {
      throw new Error(
        `${runtimeId} and another runtime claim payload directory ${name}`,
      );
    }
    runtimes[runtimeId] = {
      root: name,
      env: provisioned.env,
      envPaths: provisioned.envPaths,
      pathEnvPrepend: provisioned.pathEnvPrepend,
      pins: provisioned.pins,
    };
  }
  if (!record.toolbelt)
    throw new Error("no provisioned toolbelt; run `bun run provision` first");
  cpSync(record.toolbelt, join(directory, TOOLBELT_DIR), {
    recursive: true,
    verbatimSymlinks: true,
  });
  // Bound here, so this directory runs as a payload in place.
  bindToolbelt(directory);
  const manifest: PayloadManifest = {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    version,
    platform,
    runtimes,
  };
  writeJson(join(directory, PAYLOAD_MANIFEST), manifest);
  openToEveryone(directory);
  if (telemetryEnabled())
    for (const name of [...placed.keys(), TOOLBELT_DIR])
      recordArtifact(`payload/${name}`, treeBytes(join(directory, name)));
  return directory;
}
