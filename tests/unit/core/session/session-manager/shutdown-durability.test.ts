import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  type StartSessionInput,
  type TransportSessionHandle,
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  SessionManager,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

class TrackingTransport extends FakeTransport {
  shutdownCount = 0;
  terminatedSessionIds: string[] = [];

  override async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    return super.startSession(input);
  }

  override async terminate(handle: TransportSessionHandle): Promise<void> {
    this.terminatedSessionIds.push(handle.sessionId);
    await super.terminate(handle);
  }

  override async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    await super.shutdown();
  }
}

class FirstTerminationFailsTransport extends TrackingTransport {
  private failNextTermination = true;

  override async terminate(handle: TransportSessionHandle): Promise<void> {
    if (this.failNextTermination) {
      this.failNextTermination = false;
      this.terminatedSessionIds.push(handle.sessionId);
      throw new Error("simulated termination failure");
    }
    await super.terminate(handle);
  }
}

test("shutdown suspends checkpointed sessions and prunes ephemeral ones", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new TrackingTransport(false);
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

    const checkpointed = await manager.createWithPolicy(
      "actor_1",
      "checkpointed",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { answer: 41 } },
      "controller",
    );
    const ephemeral = await manager.create("actor_2", "ephemeral", dir);
    const active = await manager.submitExec(
      checkpointed.sessionId,
      "actor_1",
      "await Bun.sleep(60_000)",
    );
    const queued = await manager.submitExec(
      checkpointed.sessionId,
      "actor_1",
      "42",
    );

    expect(transport.sessions.size).toBe(2);
    expect(manager.detail(checkpointed.sessionId)).toEqual(
      expect.objectContaining({
        activeExecId: active.execId,
        queuedExecIds: [queued.execId],
      }),
    );

    await manager.shutdown();

    expect(transport.shutdownCount).toBe(1);
    expect(transport.sessions.size).toBe(0);
    expect(transport.terminatedSessionIds.sort()).toEqual(
      [checkpointed.sessionId, ephemeral.sessionId].sort(),
    );
    expect(manager.list()).toEqual([
      expect.objectContaining({
        sessionId: checkpointed.sessionId,
        status: "suspended",
      }),
    ]);
    expect(catalogStore.read(checkpointed.sessionId)?.status).toBe("suspended");
    expect(checkpointStore.read(checkpointed.sessionId)?.value).toEqual({
      answer: 41,
    });
    expect(historyStore.read(checkpointed.sessionId)).toEqual([
      expect.objectContaining({
        execId: active.execId,
        status: "interrupted",
        interruptionReason: "server_restart",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        execId: queued.execId,
        status: "interrupted",
        interruptionReason: "server_restart",
        durationMs: 0,
      }),
    ]);
    expect(catalogStore.read(ephemeral.sessionId)).toBeNull();
    expect(historyStore.read(ephemeral.sessionId)).toEqual([]);
    expect(checkpointStore.read(ephemeral.sessionId)).toBeNull();
  });
});

test("shutdown quarantines a checkpointed session that has no recovery point", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new TrackingTransport(false);
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

    const checkpointed = await manager.createWithPolicy(
      "actor_1",
      "checkpointed-without-recovery-point",
      dir,
      { durabilityMode: "checkpointed" },
      "controller",
    );

    expect(checkpointStore.read(checkpointed.sessionId)).toBeNull();

    await manager.shutdown();

    expect(manager.list()).toEqual([
      expect.objectContaining({
        sessionId: checkpointed.sessionId,
        status: "quarantined",
        quarantineReason: "checkpoint is missing",
      }),
    ]);
    expect(catalogStore.read(checkpointed.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: "checkpoint is missing",
      }),
    );

    const restartedManager = new SessionManager(
      new RuntimeRegistry([
        { adapter: bunAdapter, transport: new TrackingTransport(false) },
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
    await restartedManager.loadCatalog();
    expect(restartedManager.list()).toEqual([
      expect.objectContaining({
        sessionId: checkpointed.sessionId,
        status: "quarantined",
        quarantineReason: "checkpoint is missing",
      }),
    ]);
    await restartedManager.shutdown();
  });
});

test("shutdown preserves a corrupt checkpoint's concrete failure", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const manager = new SessionManager(
      new RuntimeRegistry([
        { adapter: bunAdapter, transport: new TrackingTransport(false) },
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

    const checkpointed = await manager.createWithPolicy(
      "actor_1",
      "corrupt checkpoint",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { answer: 41 } },
      "controller",
    );
    writeFileSync(
      checkpointStore.manifestPath(checkpointed.sessionId),
      "{broken",
      "utf8",
    );

    await manager.shutdown();

    expect(manager.detail(checkpointed.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining("checkpoint is unreadable"),
      }),
    );
    expect(catalogStore.read(checkpointed.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining("checkpoint is unreadable"),
      }),
    );
  });
});

test("shutdown cleans every session before reporting a termination failure", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FirstTerminationFailsTransport();
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

    const checkpointed = await manager.createWithPolicy(
      "actor_1",
      "checkpointed",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { answer: 41 } },
      "controller",
    );
    const ephemeral = await manager.create("actor_2", "ephemeral", dir);

    await expect(manager.shutdown()).rejects.toThrow(
      "session manager shutdown failed",
    );

    expect(transport.shutdownCount).toBe(1);
    expect(transport.sessions.size).toBe(0);
    expect(transport.terminatedSessionIds).toEqual([
      checkpointed.sessionId,
      ephemeral.sessionId,
    ]);
    expect(manager.list()).toEqual([
      expect.objectContaining({
        sessionId: checkpointed.sessionId,
        status: "suspended",
      }),
    ]);
    expect(catalogStore.read(checkpointed.sessionId)?.status).toBe("suspended");
    expect(catalogStore.read(ephemeral.sessionId)).toBeNull();
  });
});
