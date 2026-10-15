/**
 * The one module that knows which SQLite binding the host process has:
 * `node:sqlite` under Node, where bayma runs, and `bun:sqlite` under Bun, the
 * test runner. Callers get an exclusive lock that the operating system
 * releases when the process dies, and nothing else about SQLite.
 */

export interface ExclusiveSqliteLock {
  /** Rolls the transaction back and closes the connection. */
  close(): void;
}

export class SqliteLockContention extends Error {
  constructor(path: string, cause: unknown) {
    super(`SQLite database is locked by another connection: ${path}`, {
      cause,
    });
    this.name = "SqliteLockContention";
  }
}

const BEGIN = "BEGIN EXCLUSIVE";
const NO_WAIT = "PRAGMA busy_timeout = 0";
// The lock is the transaction's, which writes nothing. On disk, its rollback
// journal would be a file beside the database for exactly as long as the lock
// is held, open all the while: a host that saves the sandbox while the server
// runs and leaves it running, then restores that save once the server is
// gone, would find the journal gone with it, and gVisor refuses to restore a
// sandbox whose open files are missing. In memory, the lock is the database
// file's alone, which stays.
const JOURNAL_IN_MEMORY = "PRAGMA journal_mode = MEMORY";

/** Open `path` and hold its write lock until `close()`. */
export async function lockSqliteExclusively(
  path: string,
): Promise<ExclusiveSqliteLock> {
  return "Bun" in globalThis ? lockWithBun(path) : lockWithNode(path);
}

async function lockWithNode(path: string): Promise<ExclusiveSqliteLock> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(path);
  try {
    database.exec(NO_WAIT);
    database.exec(JOURNAL_IN_MEMORY);
    database.exec(BEGIN);
  } catch (error) {
    database.close();
    throw isNodeContention(error)
      ? new SqliteLockContention(path, error)
      : error;
  }
  return { close: () => database.close() };
}

async function lockWithBun(path: string): Promise<ExclusiveSqliteLock> {
  const { Database } = await import("bun:sqlite");
  const database = new Database(path, { create: true, strict: true });
  try {
    database.run(NO_WAIT);
    database.run(JOURNAL_IN_MEMORY);
    database.run(BEGIN);
  } catch (error) {
    database.close();
    throw isBunContention(error)
      ? new SqliteLockContention(path, error)
      : error;
  }
  return { close: () => database.close(true) };
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function isNodeContention(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown })?.errcode;
  return errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED;
}

function isBunContention(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}
