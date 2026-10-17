import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CheckpointStore,
  ExecHistoryStore,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";
import {
  AS_ROOT,
  goModuleCache,
  rootOwned,
} from "../../../../support/unremovable.ts";

// A cleanup never stops the server: what it cannot remove, it says, in the
// server's log, and the start or the close goes on.

const ACTOR = "actor_1";

// What the session manager reports to the server's operator, on stderr.
let reports: string[] = [];
let restoreStderr: () => void;

beforeEach(() => {
  reports = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    reports.push(String(chunk));
    return true;
  });
  restoreStderr = () => stderr.mockRestore();
});

afterEach(() => restoreStderr());

function managerIn(dir: string): SessionManager {
  return new SessionManager(
    new RuntimeRegistry([
      { adapter: bunAdapter, transport: new FakeTransport(false) },
    ]),
    new SessionCatalogStore(dir),
    new ExecHistoryStore(dir),
    new CheckpointStore(dir),
    { maxSessions: 8, warnUsagePercent: 75, defaultCols: 80, defaultRows: 24 },
    () => undefined,
  );
}

async function created(manager: SessionManager, dir: string): Promise<string> {
  const { sessionId } = await manager.createWithPolicy(
    ACTOR,
    "cleanup",
    dir,
    { durabilityMode: "checkpointed" },
    "controller",
  );
  return sessionId;
}

test("a fresh start removes a read-only Go module cache a host left in a session's scratch", async () => {
  await withTempDir(async (dir) => {
    const before = managerIn(dir);
    await before.loadCatalog();
    const sessionId = await created(before, dir);
    await before.shutdown();
    goModuleCache(join(dir, "scratch", sessionId));
    const manager = managerIn(dir);
    await manager.loadCatalog();

    expect(readdirSync(join(dir, "scratch", sessionId))).toEqual([]);
    await manager.shutdown();
  });
});

test.skipIf(!AS_ROOT)(
  "a fresh start whose session's scratch holds a tree another user owns, which it can neither change nor remove, says its path and starts",
  async () => {
    await withTempDir(async (dir) => {
      const before = managerIn(dir);
      await before.loadCatalog();
      const sessionId = await created(before, dir);
      await before.shutdown();
      const locked = join(dir, "scratch", sessionId, "locked");
      const unlock = rootOwned(locked);
      try {
        const manager = managerIn(dir);
        await manager.loadCatalog();

        expect(reports.join("")).toContain(`could not remove ${locked}`);
        // Started: it serves its sessions.
        expect(manager.list().map((session) => session.sessionId)).toEqual([
          sessionId,
        ]);
        await manager.shutdown();
      } finally {
        unlock();
      }
    });
  },
);

test("closing a session removes a read-only Go module cache in its scratch", async () => {
  await withTempDir(async (dir) => {
    const manager = managerIn(dir);
    await manager.loadCatalog();
    const sessionId = await created(manager, dir);
    goModuleCache(join(dir, "scratch", sessionId));

    await manager.close(sessionId, ACTOR);

    expect(manager.list()).toEqual([]);
    expect(existsSync(join(dir, "scratch", sessionId))).toBe(false);
    await manager.shutdown();
  });
});

test.skipIf(!AS_ROOT)(
  "closing a session whose scratch holds a tree another user owns closes it all the same, saying what it left",
  async () => {
    await withTempDir(async (dir) => {
      const manager = managerIn(dir);
      await manager.loadCatalog();
      const sessionId = await created(manager, dir);
      const scratch = join(dir, "scratch", sessionId);
      const unlock = rootOwned(join(scratch, "locked"));
      try {
        await manager.close(sessionId, ACTOR);

        expect(manager.list()).toEqual([]);
        expect(reports.join("")).toContain(`could not remove ${scratch}`);
        await manager.shutdown();
      } finally {
        unlock();
      }
    });
  },
);

test("a fresh start that cannot empty a session's scratch directory, which a host made read-only, says what it left there, and starts", async () => {
  await withTempDir(async (dir) => {
    const before = managerIn(dir);
    await before.loadCatalog();
    const sessionId = await created(before, dir);
    await before.shutdown();
    const scratch = join(dir, "scratch", sessionId);
    mkdirSync(scratch, { recursive: true });
    const left = join(scratch, "left");
    writeFileSync(left, "");
    chmodSync(scratch, 0o555);
    try {
      const manager = managerIn(dir);
      await manager.loadCatalog();

      expect(readdirSync(scratch)).toEqual(["left"]);
      expect(reports.join("")).toContain(`could not remove ${left}`);
      expect(manager.list().map((session) => session.sessionId)).toEqual([
        sessionId,
      ]);
      await manager.shutdown();
    } finally {
      chmodSync(scratch, 0o755);
    }
  });
});

test("closing a session whose scratch directory cannot be removed closes it all the same, saying what it left", async () => {
  await withTempDir(async (dir) => {
    const manager = managerIn(dir);
    await manager.loadCatalog();
    const sessionId = await created(manager, dir);
    const root = join(dir, "scratch");
    const scratch = join(root, sessionId);
    mkdirSync(scratch, { recursive: true });
    chmodSync(root, 0o555);
    try {
      await manager.close(sessionId, ACTOR);

      expect(manager.list()).toEqual([]);
      expect(existsSync(scratch)).toBe(true);
      expect(reports.join("")).toContain(`could not remove ${scratch}`);
      await manager.shutdown();
    } finally {
      chmodSync(root, 0o755);
    }
  });
});
