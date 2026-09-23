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
  CountingTransport,
  FailingCatalogStore,
  FailingRemovalCatalogStore,
  FailingPromptTransport,
} from "../../../../support/session-fixture.ts";
import { withTempDir } from "../../../../support/temp.ts";

test("a command queued behind close cannot resurrect the removed session", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const manager = new SessionManager(
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
    const created = await manager.create("controller", "close race", dir);

    const close = manager.close(created.sessionId, "controller");
    const lateSubmission = manager.submitExec(
      created.sessionId,
      "controller",
      "40 + 2",
    );
    const lateSubmissionRejected = expect(lateSubmission).rejects.toThrow(
      `unknown session ${created.sessionId}`,
    );

    await expect(close).resolves.toMatchObject({ status: "closed" });
    await lateSubmissionRejected;
    expect(manager.list()).toEqual([]);
    expect(catalogStore.read(created.sessionId)).toBeNull();
    expect(historyStore.read(created.sessionId)).toEqual([]);
    expect(checkpointStore.read(created.sessionId)).toBeNull();
    await manager.shutdown();
  });
});

test("bootstrap mutation queued behind close cannot recreate persistence", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const manager = new SessionManager(
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
    const created = await manager.createWithPolicy(
      "controller",
      "bootstrap close race",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { value: 1 } },
    );

    const close = manager.close(created.sessionId, "controller");
    const lateBootstrap = manager.setBootstrap(
      created.sessionId,
      "controller",
      "globalThis.value = 2",
    );
    const lateBootstrapRejected = expect(lateBootstrap).rejects.toThrow(
      `unknown session ${created.sessionId}`,
    );

    await expect(close).resolves.toMatchObject({ status: "closed" });
    await lateBootstrapRejected;
    expect(catalogStore.read(created.sessionId)).toBeNull();
    expect(historyStore.read(created.sessionId)).toEqual([]);
    expect(checkpointStore.read(created.sessionId)).toBeNull();
    await manager.shutdown();
  });
});

test("failed session deletion persists a closed tombstone and permits only close retry", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new FailingRemovalCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FakeTransport();
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
      "controller",
      "close tombstone",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { value: 1 } },
    );
    catalogStore.failNextRemove = true;

    await expect(
      manager.close(created.sessionId, "controller"),
    ).rejects.toThrow(
      `failed to remove persisted session ${created.sessionId}`,
    );
    expect(transport.sessions.size).toBe(0);
    expect(manager.detail(created.sessionId).status).toBe("closed");
    expect(catalogStore.read(created.sessionId)).toMatchObject({
      status: "closed",
      closed: true,
    });
    expect(historyStore.read(created.sessionId)).toEqual([]);
    expect(checkpointStore.read(created.sessionId)).not.toBeNull();

    await expect(
      manager.attach(created.sessionId, "observer", "observer"),
    ).rejects.toThrow(`session ${created.sessionId} is closed`);
    await expect(
      manager.submitExec(created.sessionId, "controller", "40 + 2"),
    ).rejects.toThrow(`session ${created.sessionId} is closed`);

    await expect(
      manager.close(created.sessionId, "controller"),
    ).resolves.toMatchObject({ status: "closed" });
    expect(() => manager.detail(created.sessionId)).toThrow(
      `unknown session ${created.sessionId}`,
    );
    expect(catalogStore.read(created.sessionId)).toBeNull();
    expect(historyStore.read(created.sessionId)).toEqual([]);
    expect(checkpointStore.read(created.sessionId)).toBeNull();
    await manager.shutdown();
  });
});

test("shutdown is idempotent and rejects later mutations", async () => {
  await withTempDir(async (dir) => {
    const transport = new CountingTransport();
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
    await manager.create("controller", "shutdown", dir);

    const firstShutdown = manager.shutdown();
    const secondShutdown = manager.shutdown();
    expect(secondShutdown).toBe(firstShutdown);
    await firstShutdown;
    await expect(
      manager.create("late-controller", "too late", dir),
    ).rejects.toThrow("session manager is shutting down");
    expect(transport.sessions.size).toBe(0);
  });
});

test("failed final creation persistence terminates the live runtime", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new FailingCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FakeTransport();
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

    catalogStore.failNextWrite = true;
    await expect(
      manager.createWithPolicy("actor_1", "failed persistence", dir, {
        durabilityMode: "ephemeral",
      }),
    ).rejects.toThrow("simulated catalog write crash");

    expect(transport.sessions.size).toBe(0);
    expect(manager.list()).toEqual([]);
    expect(catalogStore.list()).toEqual({ entries: [], failures: [] });
  });
});

test("failed ephemeral creation terminates its transport and removes partial state", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new FailingPromptTransport();
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

    await expect(
      manager.createWithPolicy("actor_1", "failed creation", dir, {
        durabilityMode: "ephemeral",
      }),
    ).rejects.toThrow("simulated prompt startup failure");
    expect(transport.sessions.size).toBe(0);
    expect(manager.list()).toEqual([]);
    expect(catalogStore.list()).toEqual({ entries: [], failures: [] });
  });
});
