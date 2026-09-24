import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOrThrow } from "./process.ts";

// Debian packages carry their files as a compressed tarball inside an `ar`
// archive. Reading the `ar` layer here keeps provisioning free of dpkg on the
// build machine; tar unpacks the tarball whatever its compression.

const AR_MAGIC = "!<arch>\n";
const AR_HEADER_BYTES = 60;

/** The members of an `ar` archive, by name. */
function readArMembers(archive: Buffer): Map<string, Buffer> {
  if (archive.toString("latin1", 0, AR_MAGIC.length) !== AR_MAGIC)
    throw new Error("not an ar archive");
  const members = new Map<string, Buffer>();
  let offset = AR_MAGIC.length;
  while (offset + AR_HEADER_BYTES <= archive.length) {
    const header = archive.toString("latin1", offset, offset + AR_HEADER_BYTES);
    const name = header.slice(0, 16).trim().replace(/\/$/, "");
    const size = Number(header.slice(48, 58).trim());
    if (!Number.isSafeInteger(size) || header.slice(58, 60) !== "`\n")
      throw new Error(`malformed ar member header at byte ${offset}`);
    const start = offset + AR_HEADER_BYTES;
    members.set(name, archive.subarray(start, start + size));
    // Members are aligned to even offsets.
    offset = start + size + (size % 2);
  }
  return members;
}

/** Unpack a Debian package's files into `destination`. */
export async function extractDeb(
  deb: string,
  destination: string,
): Promise<void> {
  const members = readArMembers(readFileSync(deb));
  const data = [...members].find(([name]) => name.startsWith("data.tar"));
  if (!data) throw new Error(`${deb} carries no data tarball`);
  const staging = mkdtempSync(join(tmpdir(), "bayma-deb-"));
  try {
    const tarball = join(staging, data[0]);
    writeFileSync(tarball, data[1]);
    await runOrThrow(["tar", "-xf", tarball, "-C", destination]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
