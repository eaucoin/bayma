import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256File } from "./hashing.ts";
import type { PinnedArchive } from "../platforms.ts";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/**
 * Download a pinned archive into `downloadsDir/<sha256>` unless it is already
 * there, and prove the bytes match the pin before returning the path.
 */
export async function fetchPinned(
  archive: PinnedArchive,
  downloadsDir: string,
  label: string,
): Promise<string> {
  mkdirSync(downloadsDir, { recursive: true });
  const target = join(downloadsDir, archive.sha256);
  if (existsSync(target) && sha256File(target) === archive.sha256)
    return target;
  rmSync(target, { force: true });

  const staging = `${target}.part`;
  rmSync(staging, { force: true });
  const response = await fetch(archive.url);
  if (!response.ok || !response.body) {
    throw new Error(
      `failed to download ${label}: ${response.status} ${response.statusText}`,
    );
  }
  let received = 0;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength;
      callback(
        received <= MAX_ARCHIVE_BYTES
          ? null
          : new Error(`${label} exceeds ${MAX_ARCHIVE_BYTES} bytes`),
        chunk,
      );
    },
  });
  mkdirSync(dirname(staging), { recursive: true });
  await pipeline(
    Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
    bound,
    createWriteStream(staging, { flags: "wx" }),
  );
  const actual = sha256File(staging);
  if (actual !== archive.sha256) {
    rmSync(staging, { force: true });
    throw new Error(`${label} digest mismatch: ${actual} != ${archive.sha256}`);
  }
  renameSync(staging, target);
  return target;
}
