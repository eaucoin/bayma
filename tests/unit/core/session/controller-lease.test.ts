import { expect, test } from "bun:test";
import {
  SessionManager,
  SessionCatalogStore,
  ExecHistoryStore,
  CheckpointStore,
  RuntimeRegistry,
  type SessionEventEnvelope,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../support/fake-transport.ts";
import { withTempDir } from "../../../support/temp.ts";

function createManager(
  dir: string,
  options: {
    maxSessions?: number;
    isActorLive?: (actorId: string) => boolean;
    actorReconnectWindowMs?: (actorId: string) => number;
    emit?: (envelope: SessionEventEnvelope) => void;
  } = {},
): SessionManager {
  return new SessionManager(
    new RuntimeRegistry([
      { adapter: bunAdapter, transport: new FakeTransport() },
    ]),
    new SessionCatalogStore(dir),
    new ExecHistoryStore(dir),
    new CheckpointStore(dir),
    {
      maxSessions: options.maxSessions ?? 8,
      warnUsagePercent: 75,
      defaultCols: 80,
      defaultRows: 24,
      isActorLive: options.isActorLive,
      actorReconnectWindowMs: options.actorReconnectWindowMs,
    },
    options.emit ?? (() => undefined),
  );
}

test("exactly one controller may mutate a session while observers stay read-only", async () => {
  await withTempDir(async (dir) => {
    const manager = createManager(dir);
    const session = await manager.create("conn_a", "title", dir, "controller");

    expect(
      manager.attach(session.sessionId, "conn_b", "controller"),
    ).rejects.toThrow("controller lease already held");
    await manager.attach(session.sessionId, "conn_b", "observer");
    expect(
      manager.submitExec(session.sessionId, "conn_b", "1 + 1"),
    ).rejects.toThrow("write action requires controller lease");
    await manager.detach(session.sessionId, "conn_a");
    const rebound = await manager.attach(
      session.sessionId,
      "conn_b",
      "controller",
    );
    expect(rebound.controllerActorId).toBe("conn_b");
    expect(rebound.observerActorIds).not.toContain("conn_b");
    await expect(
      manager.attach(session.sessionId, "conn_b", "observer"),
    ).rejects.toThrow("controller actor cannot also attach as an observer");
  });
});

test("a controller lease whose client is gone passes to the next controller", async () => {
  await withTempDir(async (dir) => {
    const live = new Set(["conn_a", "conn_b"]);
    const envelopes: SessionEventEnvelope[] = [];
    const manager = createManager(dir, {
      isActorLive: (actorId) => live.has(actorId),
      emit: (envelope) => envelopes.push(envelope),
    });
    const session = await manager.create("conn_a", "title", dir, "controller");
    await manager.attach(session.sessionId, "conn_b", "observer");

    await expect(
      manager.attach(session.sessionId, "conn_b", "controller"),
    ).rejects.toThrow("controller lease already held");

    live.delete("conn_a");
    envelopes.length = 0;
    const taken = await manager.attach(
      session.sessionId,
      "conn_b",
      "controller",
    );
    expect(taken.controllerActorId).toBe("conn_b");
    expect(taken.observerActorIds).not.toContain("conn_b");
    expect(envelopes).toContainEqual({
      actorIds: ["conn_b"],
      event: {
        type: "session/controllerChanged",
        sessionId: session.sessionId,
        actorId: "conn_b",
      },
    });
    await manager.submitExec(session.sessionId, "conn_b", "1 + 1");
    await expect(
      manager.submitExec(session.sessionId, "conn_a", "1 + 1"),
    ).rejects.toThrow("write action requires controller lease");
    await manager.shutdown();
  });
});

test("a controller lease whose client is gone does not pin its session against eviction", async () => {
  await withTempDir(async (dir) => {
    const live = new Set(["conn_a", "conn_b"]);
    const manager = createManager(dir, {
      maxSessions: 1,
      isActorLive: (actorId) => live.has(actorId),
    });
    const first = await manager.create("conn_a", "first", dir, "controller");

    await expect(
      manager.create("conn_b", "second", dir, "controller"),
    ).rejects.toThrow("session capacity exhausted");

    live.delete("conn_a");
    const second = await manager.create("conn_b", "second", dir, "controller");
    expect(manager.list().map((session) => session.sessionId)).toEqual([
      second.sessionId,
    ]);
    expect(() => manager.detail(first.sessionId)).toThrow(
      `unknown session ${first.sessionId}`,
    );
    await manager.shutdown();
  });
});

test("taking over a controller whose client is within its reconnect window waits it out", async () => {
  await withTempDir(async (dir) => {
    // conn_a lost its connections a moment ago: live for its window, then gone.
    const goneAtMs = Date.now() + 200;
    const manager = createManager(dir, {
      isActorLive: (actorId) => actorId !== "conn_a" || Date.now() < goneAtMs,
      actorReconnectWindowMs: (actorId) =>
        actorId === "conn_a" ? Math.max(0, goneAtMs - Date.now()) : 0,
    });
    const session = await manager.create("conn_a", "title", dir, "controller");

    const startedAtMs = Date.now();
    const taken = await manager.attach(
      session.sessionId,
      "conn_b",
      "controller",
    );
    expect(taken.controllerActorId).toBe("conn_b");
    expect(Date.now()).toBeGreaterThanOrEqual(goneAtMs);
    expect(Date.now() - startedAtMs).toBeLessThan(2_000);
    await manager.shutdown();
  });
});

test("a controller that reconnects within its window keeps its lease", async () => {
  await withTempDir(async (dir) => {
    // conn_a's window is open when conn_b asks, and conn_a reconnects in it.
    let reconnected = false;
    const manager = createManager(dir, {
      isActorLive: () => true,
      actorReconnectWindowMs: (actorId) =>
        actorId === "conn_a" && !reconnected ? 100 : 0,
    });
    const session = await manager.create("conn_a", "title", dir, "controller");
    setTimeout(() => {
      reconnected = true;
    }, 20);

    await expect(
      manager.attach(session.sessionId, "conn_b", "controller"),
    ).rejects.toThrow("controller lease already held");
    await manager.submitExec(session.sessionId, "conn_a", "1 + 1");
    await manager.shutdown();
  });
});
