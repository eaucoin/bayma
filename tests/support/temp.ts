import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Where a test makes the directories that a Unix socket goes in: a socket's
 * path is at most 107 bytes long, which a long TMPDIR leaves too little of.
 */
export const SOCKET_TEMP_ROOT = "/tmp";

export function withTempDir<T>(
  fn: (dir: string) => T | Promise<T>,
  root = tmpdir(),
): Promise<T> | T {
  const dir = mkdtempSync(join(root, "bayma-"));
  try {
    const result = fn(dir);
    if (result instanceof Promise) {
      return result.finally(() =>
        rmSync(dir, { recursive: true, force: true }),
      );
    }
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
