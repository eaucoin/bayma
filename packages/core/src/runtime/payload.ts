import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { cacheRoot, type PathEnvironment } from "../paths.ts";
import { hostPlatformId, type PlatformId } from "./platform.ts";
import { PAYLOAD_MANIFEST } from "./payload-environment.ts";
import { bindToolbelt, linkToolbelt } from "./toolbelt.ts";
import { BAYMA_VERSION } from "../version.ts";

/**
 * bayma ships its own toolchains. They are too large to live inside the npm
 * package, so the package carries a pinned release for each platform and the
 * install downloads that one archive, verifies its digest, and unpacks it
 * once per machine and version. The payload also carries the toolbelt, which
 * every install binds to where it unpacked it and links into place.
 */

export const PAYLOAD_RELEASE_MANIFEST = "payloads.json";
const COMPLETE_MARKER = ".payload";

export interface PayloadRelease {
  version: string;
  payloads: Record<string, { url: string; sha256: string; bytes: number }>;
}

export function payloadDir(
  version: string = BAYMA_VERSION,
  env: PathEnvironment = process.env,
): string {
  return env.BAYMA_PAYLOAD_DIR ?? join(cacheRoot(env), "payloads", version);
}

function isComplete(directory: string, version: string): boolean {
  const marker = join(directory, COMPLETE_MARKER);
  return (
    existsSync(join(directory, PAYLOAD_MANIFEST)) &&
    existsSync(marker) &&
    readFileSync(marker, "utf8").trim() === version
  );
}

/** The release the package was published with, beside the bundle. */
export function readPayloadRelease(
  from: string = dirname(fileURLToPath(import.meta.url)),
): PayloadRelease {
  const path = join(from, PAYLOAD_RELEASE_MANIFEST);
  if (!existsSync(path)) {
    throw new Error(
      `this build carries no payload release (${PAYLOAD_RELEASE_MANIFEST} is missing); set BAYMA_PAYLOAD_DIR to a payload built from this repository`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as PayloadRelease;
}

async function download(
  url: string,
  destination: string,
  expected: { sha256: string; bytes: number },
  report: (message: string) => void,
): Promise<void> {
  report(`bayma: downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`payload download failed with HTTP ${response.status}`);
  }
  const digest = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(
      response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    ),
    async function* (source) {
      for await (const chunk of source) {
        const buffer = chunk as Buffer;
        digest.update(buffer);
        bytes += buffer.byteLength;
        yield buffer;
      }
    },
    createWriteStream(destination),
  );
  const sha256 = digest.digest("hex");
  if (bytes !== expected.bytes || sha256 !== expected.sha256) {
    rmSync(destination, { force: true });
    throw new Error(
      `payload does not match its pinned identity: expected ${expected.bytes} bytes sha256 ${expected.sha256}, got ${bytes} bytes sha256 ${sha256}`,
    );
  }
}

export interface EnsurePayloadOptions {
  version?: string;
  platform?: PlatformId;
  release?: PayloadRelease;
  env?: PathEnvironment;
  report?: (message: string) => void;
}

/**
 * The payload directory for this version, downloading it once if it is
 * absent, with its toolbelt linked into place. A `BAYMA_PAYLOAD_DIR` override
 * is used as it is and changes nothing else on the machine.
 */
export async function ensurePayload(
  options: EnsurePayloadOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const version = options.version ?? BAYMA_VERSION;
  const report =
    options.report ?? ((message) => process.stderr.write(message + "\n"));
  const directory = payloadDir(version, env);
  if (env.BAYMA_PAYLOAD_DIR) {
    if (!existsSync(join(directory, PAYLOAD_MANIFEST))) {
      throw new Error(
        `BAYMA_PAYLOAD_DIR holds no ${PAYLOAD_MANIFEST}: ${directory}`,
      );
    }
    return directory;
  }
  if (!isComplete(directory, version))
    await installPayload(directory, version, options, report);
  linkToolbelt(directory, env, report);
  return directory;
}

async function installPayload(
  directory: string,
  version: string,
  options: EnsurePayloadOptions,
  report: (message: string) => void,
): Promise<void> {
  const platform = options.platform ?? hostPlatformId();
  const release = options.release ?? readPayloadRelease();
  const pinned = release.payloads[platform];
  if (!pinned) {
    throw new Error(
      `bayma ${release.version} publishes no payload for ${platform}; it publishes ${Object.keys(release.payloads).join(", ")}`,
    );
  }
  mkdirSync(dirname(directory), { recursive: true });
  const staging = mkdtempSync(`${directory}.`);
  try {
    const archive = join(staging, "payload.tar.gz");
    await download(pinned.url, archive, pinned, report);
    report("bayma: unpacking the payload");
    const extracted = spawnSync(
      "tar",
      ["-xzf", archive, "-C", staging, "--strip-components=1"],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    if (extracted.status !== 0) {
      throw new Error(
        `unpacking the payload failed: ${extracted.stderr.trim()}`,
      );
    }
    rmSync(archive, { force: true });
    if (!existsSync(join(staging, PAYLOAD_MANIFEST))) {
      throw new Error(`the payload archive carries no ${PAYLOAD_MANIFEST}`);
    }
    bindToolbelt(staging, directory);
    writeFileSync(join(staging, COMPLETE_MARKER), version + "\n");
    try {
      renameSync(staging, directory);
    } catch (error) {
      // Another install won the race; its copy is the same archive.
      if (!isComplete(directory, version)) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  report(`bayma: payload ready at ${directory}`);
}
