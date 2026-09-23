import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  type SessionEvent,
  SessionManager,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import {
  CountingTransport,
  FailingCatalogStore,
  FailingBootstrapTransport,
  IncompatibleCheckpointTransport,
  ValidCheckpointTransport,
  PreservedCheckpointTransport,
} from "../../../../support/session-fixture.ts";
import { withTempDir } from "../../../../support/temp.ts";

test("checkpoint failure quarantines, terminates, and rejects later work", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new IncompatibleCheckpointTransport();
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      catalogStore,
      historyStore,
      checkpointStore,
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );
    const created = await manager.createWithPolicy(
      "actor_1",
      "incompatible checkpoint",
      dir,
      {
        durabilityMode: "checkpointed",
        initialCheckpoint: { answer: 41 },
      },
      "controller",
    );

    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "42",
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        manager.exec(created.sessionId, submitted.execId).status !== "queued"
      ) {
        break;
      }
      await Bun.sleep(1);
    }

    expect(manager.exec(created.sessionId, submitted.execId).status).toBe(
      "error",
    );
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "runtime bun emitted a python checkpoint",
        ),
      }),
    );
    expect(transport.sessions.size).toBe(0);
    await expect(
      manager.submitExec(created.sessionId, "actor_1", "43"),
    ).rejects.toThrow("runtime bun emitted a python checkpoint");
    expect(manager.execs(created.sessionId)).toHaveLength(1);
  });
});

test("checkpoint errors without a valid commit fail closed and reject later work", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FailingBootstrapTransport();
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      catalogStore,
      historyStore,
      checkpointStore,
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );
    const created = await manager.createWithPolicy(
      "actor_1",
      "checkpoint serialization failure",
      dir,
      {
        durabilityMode: "checkpointed",
        initialCheckpoint: { answer: 41 },
      },
      "controller",
    );

    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "42",
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (
        manager.exec(created.sessionId, submitted.execId).status !== "queued"
      ) {
        break;
      }
      await Bun.sleep(1);
    }

    expect(manager.exec(created.sessionId, submitted.execId).status).toBe(
      "error",
    );
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "without emitting a checkpoint",
        ),
      }),
    );
    expect(transport.sessions.size).toBe(0);
    await expect(
      manager.submitExec(created.sessionId, "actor_1", "43"),
    ).rejects.toThrow("without emitting a checkpoint");
    expect(manager.execs(created.sessionId)).toHaveLength(1);
  });
});

test("checkpoint preservation is exact, error-only, and mutually exclusive", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new PreservedCheckpointTransport();
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      catalogStore,
      historyStore,
      checkpointStore,
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );
    const created = await manager.createWithPolicy(
      "actor_1",
      "checkpoint preservation",
      dir,
      {
        durabilityMode: "checkpointed",
        initialCheckpoint: { answer: 41 },
      },
      "controller",
    );
    const manifestPath = checkpointStore.manifestPath(created.sessionId);
    const before = readFileSync(manifestPath, "utf8");

    const failed = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "compile failure",
    );
    transport.completeWithPreservation(created.sessionId, true);
    await Bun.sleep(0);

    expect(manager.exec(created.sessionId, failed.execId).status).toBe("error");
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(manager.detail(created.sessionId).status).toBe("live_idle");

    const conflicting = await manager.createWithPolicy(
      "actor_2",
      "checkpoint outcome conflict",
      dir,
      {
        durabilityMode: "checkpointed",
        initialCheckpoint: { answer: 42 },
      },
      "controller",
    );
    const conflictingManifestPath = checkpointStore.manifestPath(
      conflicting.sessionId,
    );
    const conflictingBefore = readFileSync(conflictingManifestPath, "utf8");

    const invalid = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "successful preservation",
    );
    transport.completeWithPreservation(created.sessionId, false);
    await Bun.sleep(0);

    expect(manager.exec(created.sessionId, invalid.execId).status).toBe(
      "error",
    );
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "preserved a checkpoint after a successful exec",
        ),
      }),
    );

    const mixed = await manager.submitExec(
      conflicting.sessionId,
      "actor_2",
      "conflicting preservation and commit",
    );
    transport.completeWithConflict(conflicting.sessionId);
    await Bun.sleep(0);

    expect(manager.exec(conflicting.sessionId, mixed.execId).status).toBe(
      "error",
    );
    expect(readFileSync(conflictingManifestPath, "utf8")).toBe(
      conflictingBefore,
    );
    expect(manager.detail(conflicting.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "conflicting checkpoint outcomes",
        ),
      }),
    );
  });
});

test("post-commit catalog failures preserve truthful checkpoint authority", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new FailingCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new ValidCheckpointTransport();
    const events: SessionEvent[] = [];
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      catalogStore,
      historyStore,
      checkpointStore,
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      ({ event }) => events.push(event),
    );
    const created = await manager.createWithPolicy(
      "actor_1",
      "post-commit projection failure",
      dir,
      {
        durabilityMode: "checkpointed",
        initialCheckpoint: { committed: false },
      },
      "controller",
    );
    events.length = 0;

    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "42",
    );
    catalogStore.failNextWrite = true;
    transport.completeWithCheckpoint(created.sessionId);
    await Bun.sleep(0);

    const checkpoint = checkpointStore.read(created.sessionId);
    expect(checkpoint).not.toBeNull();
    if (!checkpoint) throw new Error("expected an authoritative checkpoint");
    expect(checkpoint.value).toEqual({ committed: true });
    expect(manager.exec(created.sessionId, submitted.execId)).toEqual(
      expect.objectContaining({
        status: "error",
        messages: [
          expect.objectContaining({
            kind: "error",
            text: expect.stringContaining(
              "committed, but its session metadata could not be persisted",
            ),
          }),
        ],
      }),
    );
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          `checkpoint ${checkpoint.revision} committed`,
        ),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session/checkpointCommitted",
        checkpointRevision: checkpoint.revision,
      }),
    );
    expect(events.map((event) => event.type)).not.toContain(
      "session/checkpointFailed",
    );
    expect(transport.sessions.size).toBe(0);
  });
});

test("recovery history survives a catalog-write crash without timestamp drift", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new FailingCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const sessionId = "sess_crash_window";
    catalogStore.write({
      sessionId,
      runtimeId: "bun",
      title: "crash-safe recovery",
      cwd: dir,
      status: "live_busy",
      durabilityMode: "checkpointed",
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });
    historyStore.write(sessionId, [
      {
        execId: "exec_orphan",
        code: "never replay",
        status: "running",
        submittedAtMs: 1,
        startedAtMs: 2,
        messages: [],
      },
    ]);

    const createManager = () =>
      new SessionManager(
        new RuntimeRegistry([
          { adapter: bunAdapter, transport: new CountingTransport() },
        ]),
        catalogStore,
        historyStore,
        checkpointStore,
        {
          maxSessions: 8,
          warnUsagePercent: 75,
          defaultCols: 80,
          defaultRows: 24,
        },
        () => undefined,
      );

    catalogStore.failNextWrite = true;
    await expect(createManager().loadCatalog()).rejects.toThrow(
      "simulated catalog write crash",
    );
    const afterCrash = historyStore.read(sessionId);
    expect(afterCrash[0]).toEqual(
      expect.objectContaining({
        status: "interrupted",
        interruptionReason: "server_restart",
        finishedAtMs: expect.any(Number),
      }),
    );

    const retried = createManager();
    await retried.loadCatalog();
    expect(retried.execs(sessionId)).toEqual(afterCrash);
    expect(historyStore.read(sessionId)).toEqual(afterCrash);
  });
});
