import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, isAbsolute, normalize } from "node:path";
import { inflateRawSync } from "node:zlib";

// Bun publishes its binaries as zip archives. Reading them here keeps
// provisioning free of an `unzip` on the build machine, and the archives are
// small and flat, so the central directory is all that has to be understood.

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const STORED = 0;
const DEFLATED = 8;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readCentralDirectory(archive: Buffer): ZipEntry[] {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== END_OF_CENTRAL_DIRECTORY) {
    end -= 1;
  }
  if (end < 0) throw new Error("zip archive has no end-of-central-directory");
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_FILE_HEADER)
      throw new Error("zip central directory is malformed");
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push({
      name: archive.toString("utf8", offset + 46, offset + 46 + nameLength),
      method: archive.readUInt16LE(offset + 10),
      compressedSize: archive.readUInt32LE(offset + 20),
      uncompressedSize: archive.readUInt32LE(offset + 24),
      localHeaderOffset: archive.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryContent(archive: Buffer, entry: ZipEntry): Buffer {
  const header = entry.localHeaderOffset;
  const nameLength = archive.readUInt16LE(header + 26);
  const extraLength = archive.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const raw = archive.subarray(start, start + entry.compressedSize);
  const content = entry.method === DEFLATED ? inflateRawSync(raw) : raw;
  if (entry.method !== DEFLATED && entry.method !== STORED)
    throw new Error(`zip entry ${entry.name} uses compression ${entry.method}`);
  if (content.byteLength !== entry.uncompressedSize)
    throw new Error(`zip entry ${entry.name} did not inflate to its size`);
  return content;
}

/**
 * Extract every file in `archivePath` into `directory`, dropping the archive's
 * leading directory component the way `unzip -j` does for a flat payload.
 */
export function extractZipFlat(archivePath: string, directory: string): void {
  const archive = readFileSync(archivePath);
  mkdirSync(directory, { recursive: true });
  for (const entry of readCentralDirectory(archive)) {
    if (entry.name.endsWith("/")) continue;
    const name = entry.name.split("/").at(-1)!;
    if (!name || name === "." || name === "..")
      throw new Error(`zip entry has no usable name: ${entry.name}`);
    const destination = join(directory, name);
    if (isAbsolute(name) || normalize(destination) !== destination)
      throw new Error(`zip entry escapes its directory: ${entry.name}`);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entryContent(archive, entry));
  }
}
