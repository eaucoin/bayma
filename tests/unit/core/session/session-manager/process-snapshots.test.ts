import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckpointStore,
  ExecHistoryStore,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  type SessionCreatePolicy,
  type SessionSummary,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import {
  FAKE_SNAPSHOT_IMAGE,
  PidReservingSnapshotter,
  SnapshottingTransport,
} from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

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

interface Stores {
  catalogStore: SessionCatalogStore;
  historyStore: ExecHistoryStore;
  checkpointStore: CheckpointStore;
}

function stores(dir: string): Stores {
  return {
    catalogStore: new SessionCatalogStore(dir),
    historyStore: new ExecHistoryStore(dir),
    checkpointStore: new CheckpointStore(dir),
  };
}

function managerFor(
  { catalogStore, historyStore, checkpointStore }: Stores,
  transport: SnapshottingTransport,
  processSnapshotter = new PidReservingSnapshotter(),
): SessionManager {
  return new SessionManager(
    new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
    catalogStore,
    historyStore,
    checkpointStore,
    {
      maxSessions: 8,
      warnUsagePercent: 75,
      defaultCols: 80,
      defaultRows: 24,
      processSnapshotter,
    },
    () => undefined,
  );
}

async function createCheckpointed(
  manager: SessionManager,
  dir: string,
  policy: Partial<SessionCreatePolicy> = {},
): Promise<string> {
  const created = await manager.createWithPolicy(
    "actor_1",
    "snapshotted",
    dir,
    {
      durabilityMode: "checkpointed",
      bootstrapCode: "globalThis.answer = globalThis.$checkpoint?.answer;",
      initialCheckpoint: { answer: 41 },
      ...policy,
    },
    "controller",
  );
  return created.sessionId;
}

/** A checkpointed session whose server stopped, dumping its runtime. */
async function snapshottedSession(
  dir: string,
  policy?: Partial<SessionCreatePolicy>,
): Promise<string> {
  const manager = managerFor(stores(dir), new SnapshottingTransport());
  const sessionId = await createCheckpointed(manager, dir, policy);
  await manager.shutdown();
  return sessionId;
}

/** Take control of a reloaded session and bring its runtime back. */
async function recoverAfterReload(
  manager: SessionManager,
  sessionId: string,
): Promise<SessionSummary> {
  await manager.attach(sessionId, "actor_2", "controller");
  return manager.recoverSession(sessionId, "actor_2");
}

const snapshotDir = (dir: string, sessionId: string) =>
  join(dir, "snapshots", sessionId);
const scratchDir = (dir: string, sessionId: string) =>
  join(dir, "scratch", sessionId);

test("shutdown snapshots an idle checkpointed session, which is suspended with its snapshot", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const transport = new SnapshottingTransport();
    const manager = managerFor(stores(dir), transport);
    const sessionId = await createCheckpointed(manager, dir);

    await manager.shutdown();

    expect(transport.dumps).toEqual([
      {
        sessionId,
        directory: snapshotDir(dir, sessionId),
        snapshot: expect.any(Object),
      },
    ]);
    expect(manager.list()).toEqual([
      expect.objectContaining({ sessionId, status: "suspended" }),
    ]);
    expect(catalogStore.read(sessionId)).toEqual(
      expect.objectContaining({
        status: "suspended",
        processSnapshot: transport.dumps[0]!.snapshot,
      }),
    );
    expect(
      existsSync(join(snapshotDir(dir, sessionId), FAKE_SNAPSHOT_IMAGE)),
    ).toBe(true);
    expect(reports).toEqual([]);
  });
});

test("shutdown stops rather than snapshots a busy session or an ephemeral one", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const transport = new SnapshottingTransport(false);
    const manager = managerFor(stores(dir), transport);
    const busy = await createCheckpointed(manager, dir);
    await manager.submitExec(busy, "actor_1", "await Bun.sleep(60_000)");
    const ephemeral = await manager.createWithPolicy(
      "actor_2",
      "ephemeral",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );

    await manager.shutdown();

    expect(transport.dumps).toEqual([]);
    expect(catalogStore.read(busy)).toEqual(
      expect.objectContaining({ status: "suspended" }),
    );
    expect(catalogStore.read(busy)?.processSnapshot).toBeUndefined();
    expect(catalogStore.read(ephemeral.sessionId)).toBeNull();
    expect(existsSync(join(dir, "snapshots"))).toBe(false);
  });
});

test("a session whose runtime fails to dump comes back from its checkpoint", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const transport = new SnapshottingTransport();
    transport.snapshotFailure = "simulated dump failure";
    const manager = managerFor(stores(dir), transport);
    const sessionId = await createCheckpointed(manager, dir);

    await manager.shutdown();

    expect(transport.sessions.size).toBe(0);
    expect(catalogStore.read(sessionId)).toEqual(
      expect.objectContaining({ status: "suspended" }),
    );
    expect(catalogStore.read(sessionId)?.processSnapshot).toBeUndefined();
    expect(reports).toEqual([
      `bayma: session ${sessionId} will come back from its checkpoint, not a process snapshot: simulated dump failure\n`,
    ]);
  });
});

test("a session comes back from its process snapshot, not its checkpoint", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const sessionId = await snapshottedSession(dir);
    const generation = catalogStore.read(sessionId)!.runtimeGeneration;
    const transport = new SnapshottingTransport();
    const manager = managerFor(stores(dir), transport);
    await manager.loadCatalog();

    const recovered = await recoverAfterReload(manager, sessionId);

    expect(recovered.status).toBe("live_idle");
    // Restored, not started: nothing bootstrapped or hydrated it.
    expect(transport.starts).toEqual([]);
    expect(transport.restores).toEqual([
      expect.objectContaining({
        sessionId,
        scratchDir: scratchDir(dir, sessionId),
      }),
    ]);
    // The restored runtime answered its doctor probe, which left no history.
    expect(transport.requireSession(sessionId).writes).toHaveLength(1);
    expect(manager.execIds(sessionId)).toEqual([]);
    expect(catalogStore.read(sessionId)).toEqual(
      expect.objectContaining({
        status: "live_idle",
        runtimeGeneration: generation + 1,
      }),
    );
    // The snapshot is spent.
    expect(catalogStore.read(sessionId)?.processSnapshot).toBeUndefined();
    expect(existsSync(snapshotDir(dir, sessionId))).toBe(false);
    expect(existsSync(scratchDir(dir, sessionId))).toBe(true);
    await manager.shutdown();
  });
});

test.each([
  {
    failure: "fails to restore",
    fail: (transport: SnapshottingTransport) => {
      transport.restoreFailure = "simulated restore failure";
    },
    reason: "simulated restore failure",
    // Only the runtime started from the checkpoint is a new generation.
    generations: 1,
  },
  {
    failure: "answers its probe wrongly",
    fail: (transport: SnapshottingTransport) => {
      transport.probeAnswer = "41";
    },
    reason: "doctor exec completed without the exact expected result",
    // The restored runtime was one, and the one that replaced it another.
    generations: 2,
  },
])(
  "a session whose snapshot $failure comes back from its checkpoint",
  async ({ fail, reason, generations }) => {
    await withTempDir(async (dir) => {
      const { catalogStore } = stores(dir);
      const sessionId = await snapshottedSession(dir);
      const generation = catalogStore.read(sessionId)!.runtimeGeneration;
      const transport = new SnapshottingTransport();
      fail(transport);
      const manager = managerFor(stores(dir), transport);
      await manager.loadCatalog();

      const recovered = await recoverAfterReload(manager, sessionId);

      expect(recovered.status).toBe("live_idle");
      expect(transport.restores).toHaveLength(1);
      expect(transport.starts).toHaveLength(1);
      expect(catalogStore.read(sessionId)).toEqual(
        expect.objectContaining({
          status: "live_idle",
          runtimeGeneration: generation + generations,
        }),
      );
      expect(catalogStore.read(sessionId)?.processSnapshot).toBeUndefined();
      expect(existsSync(snapshotDir(dir, sessionId))).toBe(false);
      expect(reports).toEqual([
        `bayma: session ${sessionId}'s process snapshot did not restore: ${reason}\n`,
      ]);
      await manager.shutdown();
    });
  },
);

test("an unrestorable snapshot is dropped as the catalog loads", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const sessionId = await snapshottedSession(dir);
    const transport = new SnapshottingTransport();
    transport.unrestorable = "the machine has restarted since it was taken";
    const snapshotter = new PidReservingSnapshotter();
    const manager = managerFor(stores(dir), transport, snapshotter);

    await manager.loadCatalog();

    expect(reports).toEqual([
      `bayma: session ${sessionId}'s process snapshot cannot be restored: the machine has restarted since it was taken\n`,
    ]);
    expect(catalogStore.read(sessionId)).toEqual(
      expect.objectContaining({ status: "suspended" }),
    );
    expect(catalogStore.read(sessionId)?.processSnapshot).toBeUndefined();
    expect(existsSync(snapshotDir(dir, sessionId))).toBe(false);
    expect(snapshotter.advancedPast).toEqual([]);

    expect((await recoverAfterReload(manager, sessionId)).status).toBe(
      "live_idle",
    );
    expect(transport.restores).toEqual([]);
    expect(transport.starts).toHaveLength(1);
    await manager.shutdown();
  });
});

test("a session that comes back from neither its snapshot nor its checkpoint is quarantined with both reasons", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore, checkpointStore } = stores(dir);
    const sessionId = await snapshottedSession(dir);
    expect(catalogStore.read(sessionId)?.status).toBe("suspended");
    writeFileSync(checkpointStore.manifestPath(sessionId), "{broken", "utf8");
    const transport = new SnapshottingTransport();
    transport.restoreFailure = "simulated restore failure";
    const manager = managerFor(stores(dir), transport);
    await manager.loadCatalog();
    await manager.attach(sessionId, "actor_2", "controller");
    const reason =
      "the session came back from neither its process snapshot (simulated restore failure) nor its checkpoint (checkpoint is unreadable";

    await expect(manager.recoverSession(sessionId, "actor_2")).rejects.toThrow(
      reason,
    );

    expect(manager.detail(sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(reason),
      }),
    );
    expect(catalogStore.read(sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(reason),
      }),
    );
    expect(catalogStore.read(sessionId)?.processSnapshot).toBeUndefined();
    expect(transport.starts).toEqual([]);
    await manager.shutdown();
  });
});

test("loading moves the PID counter past every stored snapshot's highest PID", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const original = managerFor(stores(dir), new SnapshottingTransport());
    const first = await createCheckpointed(original, dir);
    const second = await createCheckpointed(original, dir);
    await original.shutdown();
    const maxPids = [first, second].map(
      (sessionId) => catalogStore.read(sessionId)!.processSnapshot!.maxPid,
    );
    expect(new Set(maxPids).size).toBe(2);
    const snapshotter = new PidReservingSnapshotter();

    await managerFor(
      stores(dir),
      new SnapshottingTransport(),
      snapshotter,
    ).loadCatalog();

    expect(snapshotter.advancedPast).toEqual([Math.max(...maxPids)]);
  });
});

test("loading removes the scratch and snapshot directories no session owns", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const original = managerFor(stores(dir), new SnapshottingTransport(false));
    const snapshotted = await createCheckpointed(original, dir);
    const busy = await createCheckpointed(original, dir);
    await original.submitExec(busy, "actor_1", "await Bun.sleep(60_000)");
    await original.shutdown();
    expect(catalogStore.read(busy)?.processSnapshot).toBeUndefined();
    // A dump that a crash interrupted, and a closed session's leftovers.
    mkdirSync(snapshotDir(dir, busy), { recursive: true });
    mkdirSync(scratchDir(dir, "sess_gone"), { recursive: true });
    mkdirSync(snapshotDir(dir, "sess_gone"), { recursive: true });

    await managerFor(stores(dir), new SnapshottingTransport()).loadCatalog();

    expect(existsSync(scratchDir(dir, snapshotted))).toBe(true);
    expect(existsSync(snapshotDir(dir, snapshotted))).toBe(true);
    expect(existsSync(scratchDir(dir, busy))).toBe(true);
    expect(existsSync(snapshotDir(dir, busy))).toBe(false);
    expect(existsSync(scratchDir(dir, "sess_gone"))).toBe(false);
    expect(existsSync(snapshotDir(dir, "sess_gone"))).toBe(false);
  });
});

test("closing a session removes its scratch and snapshot directories", async () => {
  await withTempDir(async (dir) => {
    const sessionId = await snapshottedSession(dir);
    const manager = managerFor(stores(dir), new SnapshottingTransport());
    await manager.loadCatalog();
    await manager.attach(sessionId, "actor_2", "controller");
    expect(existsSync(scratchDir(dir, sessionId))).toBe(true);
    expect(existsSync(snapshotDir(dir, sessionId))).toBe(true);

    await manager.close(sessionId, "actor_2");

    expect(existsSync(scratchDir(dir, sessionId))).toBe(false);
    expect(existsSync(snapshotDir(dir, sessionId))).toBe(false);
  });
});

test("sessions are checkpointed unless a create policy says otherwise", async () => {
  await withTempDir(async (dir) => {
    const { catalogStore } = stores(dir);
    const manager = managerFor(stores(dir), new SnapshottingTransport());

    const created = await manager.create("actor_1", "default", dir);

    expect(catalogStore.read(created.sessionId)?.durabilityMode).toBe(
      "checkpointed",
    );
    await manager.shutdown();
  });
});
