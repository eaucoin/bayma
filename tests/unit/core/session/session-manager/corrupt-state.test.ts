import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  SessionManager,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { CountingWritesTransport } from "../../../../support/session-fixture.ts";
import { withTempDir } from "../../../../support/temp.ts";

test("incompatible checkpoint runtimes are quarantined before recovery", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const sessionId = "sess_wrong_runtime";
    catalogStore.write({
      sessionId,
      runtimeId: "bun",
      title: "wrong runtime",
      cwd: dir,
      status: "suspended",
      durabilityMode: "checkpointed",
      checkpointRevision: "ckpt_wrong_runtime",
      checkpointUpdatedAtMs: 2,
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });
    checkpointStore.writeCommit(sessionId, {
      runtimeId: "python",
      codecId: "python-pickle-protocol5-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 41 },
    });

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
    await manager.loadCatalog();

    expect(manager.list()).toEqual([
      expect.objectContaining({
        sessionId,
        status: "quarantined",
        quarantineReason: "checkpoint runtime python is incompatible with bun",
      }),
    ]);
  });
});

test("incompatible checkpoint codecs are quarantined before recovery", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const sessionId = "sess_wrong_codec";
    catalogStore.write({
      sessionId,
      runtimeId: "bun",
      title: "wrong codec",
      cwd: dir,
      status: "suspended",
      durabilityMode: "checkpointed",
      checkpointRevision: "ckpt_wrong_codec",
      checkpointUpdatedAtMs: 2,
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });
    checkpointStore.writeCommit(sessionId, {
      runtimeId: "bun",
      codecId: "unknown-codec",
      codecVersion: 9,
      payloadKind: "json-inline",
      inlineJson: { answer: 41 },
    });

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
    await manager.loadCatalog();

    expect(manager.list()).toEqual([
      expect.objectContaining({
        sessionId,
        status: "quarantined",
        quarantineReason:
          "checkpoint codec unknown-codec@9/json-inline is incompatible with bun",
      }),
    ]);
    expect(manager.recoveryState(sessionId)).toEqual(
      expect.objectContaining({ canRecover: false, hasCheckpoint: true }),
    );
    expect(transport.sessions.size).toBe(0);
  });
});

test("recovery revalidates a checkpoint changed after catalog load before spawning", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const sessionId = "sess_changed_codec";
    catalogStore.write({
      sessionId,
      runtimeId: "bun",
      title: "changed codec",
      cwd: dir,
      status: "suspended",
      durabilityMode: "checkpointed",
      checkpointRevision: "ckpt_initial",
      checkpointUpdatedAtMs: 2,
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });
    checkpointStore.writeCommit(sessionId, {
      runtimeId: "legacy",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 41 },
    });

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
    await manager.loadCatalog();
    await manager.attach(sessionId, "actor_1", "controller");

    checkpointStore.writeCommit(sessionId, {
      runtimeId: "bun",
      codecId: "unknown-codec",
      codecVersion: 9,
      payloadKind: "json-inline",
      inlineJson: { answer: 42 },
    });

    await expect(
      manager.submitExec(sessionId, "actor_1", "40 + 2"),
    ).rejects.toThrow(
      "checkpoint codec unknown-codec@9/json-inline is incompatible with bun",
    );
    expect(transport.sessions.size).toBe(0);
    expect(manager.detail(sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "checkpoint codec unknown-codec@9/json-inline is incompatible with bun",
        ),
      }),
    );
  });
});

test("live sessions reject corrupt checkpoint state before writing user code", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const transport = new CountingWritesTransport();
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
      "live corrupt checkpoint",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: { answer: 41 } },
      "controller",
    );
    writeFileSync(
      checkpointStore.manifestPath(created.sessionId),
      "{broken",
      "utf8",
    );

    await expect(
      manager.setBootstrap(created.sessionId, "actor_1", "globalThis.x = 1"),
    ).rejects.toThrow("checkpoint is unreadable");
    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "globalThis.shouldNotRun = true",
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        manager.exec(created.sessionId, submitted.execId).status === "error"
      ) {
        break;
      }
      await Bun.sleep(1);
    }

    expect(transport.writeCount).toBe(0);
    expect(manager.exec(created.sessionId, submitted.execId)).toEqual(
      expect.objectContaining({
        status: "error",
        messages: [
          expect.objectContaining({
            kind: "error",
            text: expect.stringContaining("checkpoint is unreadable"),
          }),
        ],
      }),
    );
    expect(manager.detail(created.sessionId)).toEqual(
      expect.objectContaining({
        status: "quarantined",
        quarantineReason: expect.stringContaining("checkpoint is unreadable"),
      }),
    );
  });
});

test("catalog checkpoint identity is derived from validated checkpoint state", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const sessionId = "sess_stale_checkpoint";
    catalogStore.write({
      sessionId,
      runtimeId: "bun",
      title: "stale checkpoint",
      cwd: dir,
      status: "suspended",
      durabilityMode: "checkpointed",
      checkpointRevision: "ckpt_missing",
      checkpointUpdatedAtMs: 2,
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });

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
    await manager.loadCatalog();

    const normalized = catalogStore.read(sessionId)!;
    expect(normalized.status).toBe("quarantined");
    expect(normalized.checkpointRevision).toBeUndefined();
    expect(normalized.checkpointUpdatedAtMs).toBeUndefined();
  });
});

test("corrupt catalog and history files quarantine without blocking or overwriting", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const corruptCatalogPath = catalogStore.entryPath("sess_bad_catalog");
    const corruptHistoryPath = historyStore.historyPath("sess_bad_history");
    writeFileSync(corruptCatalogPath, "{broken catalog", "utf8");
    catalogStore.write({
      sessionId: "sess_bad_history",
      runtimeId: "bun",
      title: "bad history",
      cwd: dir,
      status: "suspended",
      durabilityMode: "checkpointed",
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });
    writeFileSync(corruptHistoryPath, "{broken history", "utf8");

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
    await manager.loadCatalog();

    expect(manager.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: "sess_bad_catalog",
          status: "quarantined",
          quarantineReason: expect.stringContaining("catalog is unreadable"),
        }),
        expect.objectContaining({
          sessionId: "sess_bad_history",
          status: "quarantined",
          quarantineReason: expect.stringContaining("history is unreadable"),
        }),
      ]),
    );
    expect(readFileSync(corruptCatalogPath, "utf8")).toBe("{broken catalog");
    expect(readFileSync(corruptHistoryPath, "utf8")).toBe("{broken history");
  });
});

test("unsafe corrupt catalog filenames have a closeable quarantine identity", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const checkpointStore = new CheckpointStore(dir);
    const unsafeFileName = ".json";
    writeFileSync(
      join(catalogStore.sessionsDir, unsafeFileName),
      "{broken catalog",
      "utf8",
    );
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
    await manager.loadCatalog();

    const [quarantined] = manager.list();
    expect(quarantined).toEqual(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^corrupt_catalog_[0-9a-f]{64}$/),
        status: "quarantined",
        quarantineReason: expect.stringContaining(
          "does not contain a safe persisted session ID",
        ),
      }),
    );
    await manager.attach(quarantined!.sessionId, "operator", "controller");
    await manager.close(quarantined!.sessionId, "operator");
    expect(
      existsSync(join(catalogStore.sessionsDir, unsafeFileName)),
    ).toBeFalse();

    const reloaded = new SessionManager(
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
    await reloaded.loadCatalog();
    expect(reloaded.list()).toEqual([]);
    await reloaded.shutdown();
  });
});
