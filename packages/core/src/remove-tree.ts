import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** The errors of a removal that a directory's mode may cause. */
const DENIED = new Set(["EACCES", "EPERM"]);

/**
 * Removes the file or directory tree at `path`, as `rm -rf` does. It never
 * throws: it returns the error that stopped it, for its caller to log, or
 * undefined once nothing is left.
 *
 * A directory whose mode denies the removal of what it holds is made
 * writable first, as `go clean -modcache` does: a Go module cache's
 * directories are 0555. A directory whose mode this user may not change
 * stays, with what it holds: one another user owns, or an immutable one.
 *
 * `retries` retries a removal that fails as one may that a process still
 * using the tree races (rmSync's maxRetries), 50 ms more apart each time.
 */
export function removeTree(
  path: string,
  { retries = 0 }: { readonly retries?: number } = {},
): Error | undefined {
  const failure = tryRemove(path, retries);
  if (failure === undefined || !DENIED.has(codeOf(failure))) return failure;
  makeDirectoriesWritable(path);
  return tryRemove(path, retries);
}

/**
 * Removes the file or directory tree at `path` as removeTree does, but off
 * the event loop, which goes on serving meanwhile: for a tree as large as a
 * toolbelt's, whose removal would otherwise stall every request.
 */
export async function removeTreeAsync(
  path: string,
  { retries = 0 }: { readonly retries?: number } = {},
): Promise<Error | undefined> {
  const failure = await tryRemoveAsync(path, retries);
  if (failure === undefined || !DENIED.has(codeOf(failure))) return failure;
  await makeDirectoriesWritableAsync(path);
  return tryRemoveAsync(path, retries);
}

async function tryRemoveAsync(
  path: string,
  retries: number,
): Promise<Error | undefined> {
  try {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: retries,
      retryDelay: 50,
    });
    return undefined;
  } catch (error) {
    return asError(error);
  }
}

function tryRemove(path: string, retries: number): Error | undefined {
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: retries,
      retryDelay: 50,
    });
    return undefined;
  } catch (error) {
    return asError(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function codeOf(error: Error): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

/** Gives this user write and search rights on each directory under `path`, as far as it may. */
function makeDirectoriesWritable(path: string): void {
  const pending = [path];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let mode: number;
    try {
      const stat = lstatSync(next);
      if (!stat.isDirectory()) continue;
      mode = stat.mode & 0o7777;
    } catch {
      continue;
    }
    if ((mode & 0o700) !== 0o700) {
      try {
        chmodSync(next, mode | 0o700);
      } catch {}
    }
    try {
      for (const name of readdirSync(next)) pending.push(join(next, name));
    } catch {}
  }
}

/** makeDirectoriesWritable, off the event loop. */
async function makeDirectoriesWritableAsync(path: string): Promise<void> {
  const pending = [path];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    let mode: number;
    try {
      const stat = await lstat(next);
      if (!stat.isDirectory()) continue;
      mode = stat.mode & 0o7777;
    } catch {
      continue;
    }
    if ((mode & 0o700) !== 0o700) {
      try {
        await chmod(next, mode | 0o700);
      } catch {}
    }
    try {
      for (const name of await readdir(next)) pending.push(join(next, name));
    } catch {}
  }
}
