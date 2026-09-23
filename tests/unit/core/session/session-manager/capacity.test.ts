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
import { CountingTransport } from "../../../../support/session-fixture.ts";
import { withTempDir } from "../../../../support/temp.ts";

test("concurrent recovery shares one serialized runtime transition", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const seedManager = new SessionManager(
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
    const seeded = await seedManager.createWithPolicy(
      "seed-controller",
      "concurrent recovery",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { answer: 42 } },
    );
    await seedManager.shutdown();

    const transport = new CountingTransport();
    const recoveredManager = new SessionManager(
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
    await recoveredManager.loadCatalog();
    await recoveredManager.attach(
      seeded.sessionId,
      "recovery-controller",
      "controller",
    );

    const [first, second] = await Promise.all([
      recoveredManager.recoverSession(seeded.sessionId, "recovery-controller"),
      recoveredManager.recoverSession(seeded.sessionId, "recovery-controller"),
    ]);

    expect(first.status).toBe("live_idle");
    expect(second.status).toBe("live_idle");
    expect(transport.startCount).toBe(1);
    expect(transport.sessions.size).toBe(1);
    await recoveredManager.shutdown();
  });
});

test("concurrent recovery cannot overbook live runtime capacity", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const seedManager = new SessionManager(
      new RuntimeRegistry([
        { adapter: bunAdapter, transport: new FakeTransport() },
      ]),
      catalogStore,
      historyStore,
      checkpointStore,
      {
        maxSessions: 2,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );
    const first = await seedManager.createWithPolicy(
      "seed-a",
      "first suspended session",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { value: 1 } },
    );
    const second = await seedManager.createWithPolicy(
      "seed-b",
      "second suspended session",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { value: 2 } },
    );
    await seedManager.shutdown();

    const transport = new CountingTransport();
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      catalogStore,
      historyStore,
      checkpointStore,
      {
        maxSessions: 1,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );
    await manager.loadCatalog();
    await manager.attach(first.sessionId, "controller-a", "controller");
    await manager.attach(second.sessionId, "controller-b", "controller");

    const outcomes = await Promise.allSettled([
      manager.recoverSession(first.sessionId, "controller-a"),
      manager.recoverSession(second.sessionId, "controller-b"),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(transport.startCount).toBe(1);
    expect(transport.sessions.size).toBe(1);
    await manager.shutdown();
  });
});

test("concurrent creation cannot overbook session capacity", async () => {
  await withTempDir(async (dir) => {
    const transport = new CountingTransport();
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      new SessionCatalogStore(dir),
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
      {
        maxSessions: 1,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );

    const outcomes = await Promise.allSettled([
      manager.create("controller-a", "first", dir),
      manager.create("controller-b", "second", dir),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(transport.startCount).toBe(1);
    expect(transport.sessions.size).toBe(1);
    await manager.shutdown();
  });
});
