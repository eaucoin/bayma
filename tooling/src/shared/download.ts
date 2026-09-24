import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256File } from "./hashing.ts";
import type { PinnedArchive } from "../platforms.ts";
import { ATTR } from "../telemetry/attributes.ts";
import { inSpan, recordDownload } from "../telemetry/index.ts";

/** The bound on a download whose pin does not state its size. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
/** Tries at a download before a network failure fails provisioning. */
const DOWNLOAD_ATTEMPTS = 3;

/** Bytes that cannot be what the pin names; downloading again cannot help. */
class PinMismatch extends Error {}

/**
 * Download a pinned archive into `downloadsDir/<sha256>` unless it is already
 * there, and prove the bytes match the pin before returning the path. A
 * download the network interrupts is tried again; bytes that do not match
 * the pin are not.
 */
export async function fetchPinned(
  archive: PinnedArchive,
  downloadsDir: string,
  label: string,
): Promise<string> {
  return inSpan(
    `download ${label}`,
    { [ATTR.downloadLabel]: label, [ATTR.urlFull]: archive.url },
    async (span) => {
      const started = performance.now();
      mkdirSync(downloadsDir, { recursive: true });
      const target = join(downloadsDir, archive.sha256);
      const cached =
        existsSync(target) && sha256File(target) === archive.sha256;
      span.setAttribute(ATTR.downloadCached, cached);
      if (!cached) await downloadVerified(archive, target, label);
      recordDownload(
        label,
        statSync(target).size,
        (performance.now() - started) / 1000,
        cached,
      );
      return target;
    },
  );
}

/** Downloads a pinned archive to `target`, proving its bytes before it is there. */
async function downloadVerified(
  archive: PinnedArchive,
  target: string,
  label: string,
): Promise<void> {
  rmSync(target, { force: true });
  const staging = `${target}.part`;
  for (let attempt = 1; ; attempt += 1) {
    rmSync(staging, { force: true });
    try {
      await download(archive, staging, label);
      break;
    } catch (error) {
      if (error instanceof PinMismatch || attempt === DOWNLOAD_ATTEMPTS) {
        rmSync(staging, { force: true });
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `failed to download ${label} from ${archive.url} (attempt ${attempt} of ${DOWNLOAD_ATTEMPTS}): ${reason}`,
        );
      }
    }
  }
  const actual = sha256File(staging);
  if (actual !== archive.sha256) {
    rmSync(staging, { force: true });
    throw new Error(`${label} digest mismatch: ${actual} != ${archive.sha256}`);
  }
  renameSync(staging, target);
}

async function download(
  archive: PinnedArchive,
  destination: string,
  label: string,
): Promise<void> {
  const response = await fetch(archive.url);
  if (!response.ok || !response.body)
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const limit = archive.bytes ?? MAX_ARCHIVE_BYTES;
  let received = 0;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      callback(
        received <= limit
          ? null
          : new PinMismatch(`${label} exceeds ${limit} bytes`),
        chunk,
      );
    },
  });
  mkdirSync(dirname(destination), { recursive: true });
  await pipeline(
    Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
    bound,
    createWriteStream(destination, { flags: "wx" }),
  );
}
