import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function withTempDir<T>(
  fn: (dir: string) => T | Promise<T>,
): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), "bayma-"));
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
