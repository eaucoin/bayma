import { expect, test } from "bun:test";
import {
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  SessionManager,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import {
  FailingCatalogStore,
  FailingWriteTransport,
  FailingBootstrapTransport,
} from "../../../../support/session-fixture.ts";
import { withTempDir } from "../../../../support/temp.ts";

test("recovery quarantines when an internal bootstrap exec emits an error", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const original = new SessionManager(
      new RuntimeRegistry([
        { adapter: bunAdapter, transport: new FakeTransport() },
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
    const created = await original.createWithPolicy(
      "actor_1",
      "bootstrap failure",
      dir,
      {
        durabilityMode: "checkpointed",
        bootstrapCode: "throw new Error('must fail recovery')",
        initialCheckpoint: { answer: 41 },
      },
      "controller",
    );
    await original.shutdown();

    const recovered = new SessionManager(
      new RuntimeRegistry([
        { adapter: bunAdapter, transport: new FailingBootstrapTransport() },
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
    await recovered.loadCatalog();
    await recovered.attach(created.sessionId, "actor_2", "controller");

    await expect(
      recovered.recoverSession(created.sessionId, "actor_2"),
    ).rejects.toThrow("simulated bootstrap failure");
    expect(recovered.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "simulated bootstrap failure",
        ),
      }),
    );
  });
});

test("runtime callback persistence failures quarantine without escaping", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new FailingCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FakeTransport(false);
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
      "callback persistence failure",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "42",
    );

    catalogStore.failNextWrite = true;
    expect(() => transport.completeNext(created.sessionId)).not.toThrow();
    await Bun.sleep(0);

    expect(manager.exec(created.sessionId, submitted.execId)).toEqual(
      expect.objectContaining({
        status: "error",
        messages: [
          expect.objectContaining({
            kind: "error",
            text: expect.stringContaining("simulated catalog write crash"),
          }),
        ],
      }),
    );
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        activeExecId: undefined,
        queuedExecIds: [],
      }),
    );
    expect(transport.sessions.size).toBe(0);
  });
});

test("submission persistence failures quarantine and terminate", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new FailingCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FakeTransport(false);
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
    const created = await manager.create("actor_1", "submission failure", dir);

    catalogStore.failNextWrite = true;
    await expect(
      manager.submitExec(created.sessionId, "actor_1", "42"),
    ).rejects.toThrow("simulated catalog write crash");

    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "exec submission persistence failed",
        ),
        activeExecId: undefined,
        queuedExecIds: [],
      }),
    );
    expect(manager.execs(created.sessionId)).toEqual([
      expect.objectContaining({
        status: "interrupted",
        interruptionReason: "runtime_stopped",
      }),
    ]);
    expect(transport.sessions.size).toBe(0);

    await manager.shutdown();
    expect(manager.list()).toEqual([]);
    expect(catalogStore.read(created.sessionId)).toBeNull();
  });
});

test("runtime write failures quarantine instead of reusing a broken runtime", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FailingWriteTransport();
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
    const created = await manager.create("actor_1", "write failure", dir);
    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "42",
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (manager.detail(created.sessionId).status === "quarantined") break;
      await Bun.sleep(1);
    }

    expect(manager.exec(created.sessionId, submitted.execId)).toEqual(
      expect.objectContaining({
        status: "error",
        messages: [
          expect.objectContaining({
            kind: "error",
            text: expect.stringContaining("simulated runtime write failure"),
          }),
        ],
      }),
    );
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining("exec startup failed"),
        activeExecId: undefined,
      }),
    );
    expect(transport.sessions.size).toBe(0);
  });
});

test("unexpected runtime exits terminalize active work and quarantine", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      new SessionCatalogStore(dir),
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );
    const created = await manager.create("actor_1", "runtime exit", dir);
    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "await Bun.sleep(60_000)",
    );

    transport.exit(created.sessionId, new Error("simulated child exit"));
    await Bun.sleep(0);

    expect(manager.exec(created.sessionId, submitted.execId)).toEqual(
      expect.objectContaining({
        status: "error",
        messages: [
          expect.objectContaining({
            kind: "error",
            text: expect.stringContaining("simulated child exit"),
          }),
        ],
      }),
    );
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining("runtime process exited"),
        activeExecId: undefined,
        queuedExecIds: [],
      }),
    );
    expect(transport.sessions.size).toBe(0);
  });
});

test("notification sink failures never control session mutations", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport();
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      new SessionCatalogStore(dir),
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => {
        throw new Error("simulated notification failure");
      },
    );

    const created = await manager.create(
      "actor_1",
      "notification failure",
      dir,
    );
    expect(transport.sessions.size).toBe(1);
    const closed = await manager.close(created.sessionId, "actor_1");
    expect(closed.status).toBe("closed");
    expect(transport.sessions.size).toBe(0);
    expect(manager.list()).toEqual([]);
  });
});
