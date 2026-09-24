import { runOrThrow } from "./process.ts";

/**
 * Runs tar over the decompressed stream of a zstd-compressed tarball. `--long`
 * admits archives compressed with a window beyond zstd's default limit.
 */
export async function tarZstd(
  archive: string,
  tarArgs: string[],
): Promise<string> {
  return (
    await runOrThrow([
      "bash",
      "-c",
      'set -o pipefail; zstd -dcq --long=31 "$1" | tar "${@:2}"',
      "bash",
      archive,
      ...tarArgs,
    ])
  ).stdout;
}
