import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  SessionManager,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { CountingTransport } from "../../../../support/session-fixture.ts";
import { withTempDir } from "../../../../support/temp.ts";

test("catalog load neither spawns runtimes nor replays sessions", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const sessionId = "sess_1";

    catalogStore.write({
      sessionId,
      runtimeId: "bun",
      title: "recoverable",
      cwd: dir,
      status: "live_busy",
      durabilityMode: "checkpointed",
      bootstrapCode: "globalThis.answer = globalThis.$checkpoint?.answer ?? 0;",
      checkpointRevision: "ckpt_1",
      checkpointUpdatedAtMs: 2,
      runtimeGeneration: 7,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });
    historyStore.write(sessionId, [
      {
        execId: "exec_poison",
        code: 'throw new Error("should never replay")',
        status: "running",
        submittedAtMs: 1,
        startedAtMs: 1,
        messages: [],
      },
      {
        execId: "exec_queued",
        code: 'throw new Error("queued should never replay")',
        status: "queued",
        submittedAtMs: 2,
        messages: [],
      },
    ]);
    const historyPath = historyStore.historyPath(sessionId);
    const v0History = JSON.parse(readFileSync(historyPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete v0History.schemaVersion;
    writeFileSync(historyPath, JSON.stringify(v0History), "utf8");
    checkpointStore.write(sessionId, {
      revision: "ckpt_1",
      updatedAtMs: 2,
      value: { answer: 41 },
    });

    const transport = new CountingTransport();
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

    await manager.loadCatalog();
    await expect(manager.loadCatalog()).rejects.toThrow(
      "session catalog may only be loaded once",
    );

    expect(transport.startCount).toBe(0);
    expect(transport.sessions.size).toBe(0);
    expect(manager.list()).toEqual([
      expect.objectContaining({
        sessionId,
        status: "suspended",
        historyLength: 2,
      }),
    ]);
    expect(manager.execs(sessionId)[0]?.code).toContain("should never replay");
    expect(manager.execs(sessionId)).toEqual([
      expect.objectContaining({
        execId: "exec_poison",
        status: "interrupted",
        interruptionReason: "server_restart",
        finishedAtMs: expect.any(Number),
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        execId: "exec_queued",
        status: "interrupted",
        interruptionReason: "server_restart",
        finishedAtMs: expect.any(Number),
        durationMs: 0,
      }),
    ]);
    expect(historyStore.read(sessionId)).toEqual(manager.execs(sessionId));
  });
});

test("catalog load permanently prunes stale ephemeral state", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const sessionId = "sess_stale_ephemeral";
    catalogStore.write({
      sessionId,
      runtimeId: "bun",
      title: "stale ephemeral",
      cwd: dir,
      status: "live_idle",
      durabilityMode: "ephemeral",
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });
    historyStore.write(sessionId, []);
    checkpointStore.write(sessionId, {
      revision: "legacy_stale",
      updatedAtMs: 2,
      value: { shouldBeRemoved: true },
    });

    const transport = new CountingTransport();
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

    await manager.loadCatalog();

    expect(manager.list()).toEqual([]);
    expect(transport.startCount).toBe(0);
    expect(catalogStore.read(sessionId)).toBeNull();
    expect(historyStore.read(sessionId)).toEqual([]);
    expect(checkpointStore.read(sessionId)).toBeNull();
  });
});
