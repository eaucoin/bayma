import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { lockSqliteExclusively, SqliteLockContention } from "./sqlite.ts";

export interface StateDirectoryLease {
  readonly stateDir: string;
  readonly lockPath: string;
  release(): Promise<void>;
}

export async function acquireStateDirectoryLease(
  requestedStateDir: string,
): Promise<StateDirectoryLease> {
  const absoluteStateDir = resolve(requestedStateDir);
  mkdirSync(absoluteStateDir, { recursive: true, mode: 0o700 });
  const stateDir = realpathSync(absoluteStateDir);
  // Catalogs, execution history, and checkpoints can contain user code and
  // private data. The canonical root is the single confidentiality boundary
  // for every store beneath it, including files created with ordinary modes.
  chmodSync(stateDir, 0o700);
  const lockPath = join(stateDir, ".bayma-state-lease.sqlite");
  // SQLite's write lock is owned by the open connection and released by the
  // operating system if the process exits. Unlike a filesystem sentinel or a
  // Unix socket pathname, it needs neither an age heuristic nor a racy stale
  // artifact reclamation protocol.
  let lock;
  try {
    lock = await lockSqliteExclusively(lockPath);
  } catch (error) {
    if (error instanceof SqliteLockContention) {
      throw new Error(`Bayma state directory is already in use: ${stateDir}`, {
        cause: error,
      });
    }
    throw error;
  }

  let releasePromise: Promise<void> | undefined;
  return {
    stateDir,
    lockPath,
    release() {
      releasePromise ??= Promise.resolve().then(() => lock.close());
      return releasePromise;
    },
  };
}
