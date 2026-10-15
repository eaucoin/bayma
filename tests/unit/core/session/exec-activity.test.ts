import { expect, test } from "bun:test";
import {
  CheckpointStore,
  ExecHistoryStore,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  type SessionEventSink,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../support/fake-transport.ts";
import { withTempDir } from "../../../support/temp.ts";

const ACTOR = "actor_1";

function managerIn(
  dir: string,
  transport: FakeTransport,
  emit: SessionEventSink = () => undefined,
): SessionManager {
  return new SessionManager(
    new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
    new SessionCatalogStore(dir),
    new ExecHistoryStore(dir),
    new CheckpointStore(dir),
    { maxSessions: 8, warnUsagePercent: 75, defaultCols: 80, defaultRows: 24 },
    emit,
  );
}

async function createSession(
  manager: SessionManager,
  dir: string,
  durabilityMode: "ephemeral" | "checkpointed" = "ephemeral",
): Promise<string> {
  const session = await manager.createWithPolicy(
    ACTOR,
    "activity",
    dir,
    { durabilityMode },
    "controller",
  );
  return session.sessionId;
}

test("an exec counts from its submission to its end, queued behind the one running", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const startedAtMs = Date.now();
    const manager = managerIn(dir, transport);
    expect(manager.execActivity().idleSinceMs).toBeGreaterThanOrEqual(
      startedAtMs,
    );
    const first = await createSession(manager, dir);
    const second = await createSession(manager, dir);

    const one = await manager.submitExec(first, ACTOR, "1");
    await manager.submitExec(first, ACTOR, "2");
    const three = await manager.submitExec(second, ACTOR, "3");
    expect(manager.execActivity()).toEqual({
      execsRunning: 2,
      execsQueued: 1,
      running: [
        { sessionId: first, execId: one.execId },
        { sessionId: second, execId: three.execId },
      ],
      idleSinceMs: null,
      generation: expect.any(Number),
    });

    transport.completeNext(first);
    transport.completeNext(second);
    await Bun.sleep(0);
    expect(manager.execActivity()).toEqual({
      execsRunning: 1,
      execsQueued: 0,
      running: [{ sessionId: first, execId: expect.any(String) }],
      idleSinceMs: null,
      generation: expect.any(Number),
    });

    transport.completeNext(first);
    await Bun.sleep(0);
    const [last] = manager.execs(first).slice(-1);
    expect(last!.status).toBe("ok");
    expect(manager.execActivity()).toEqual({
      execsRunning: 0,
      execsQueued: 0,
      running: [],
      idleSinceMs: last!.finishedAtMs!,
      generation: expect.any(Number),
    });
  });
});

test("an exec counts until it ends, interrupted or failed", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = managerIn(dir, transport);
    const interrupted = await createSession(manager, dir);
    const failed = await createSession(manager, dir);

    await manager.submitExec(interrupted, ACTOR, "for (;;) {}");
    await manager.submitExec(failed, ACTOR, "process.exit()");
    expect(manager.execActivity().execsRunning).toBe(2);

    await manager.interrupt(interrupted, ACTOR);
    expect(manager.execActivity().execsRunning).toBe(1);

    transport.exit(failed);
    const ended = [interrupted, failed].map(
      (sessionId) => manager.execs(sessionId)[0]!,
    );
    expect(ended.map(({ status }) => status)).toEqual(["interrupted", "error"]);
    expect(manager.execActivity()).toEqual({
      execsRunning: 0,
      execsQueued: 0,
      running: [],
      idleSinceMs: Math.max(...ended.map(({ finishedAtMs }) => finishedAtMs!)),
      generation: expect.any(Number),
    });
  });
});

test("bayma's own execs, which recover sessions, are not counted", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = managerIn(dir, transport);
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "recovered",
      dir,
      {
        durabilityMode: "checkpointed",
        bootstrapCode: "globalThis.ready = true",
        initialCheckpoint: {},
      },
      "controller",
    );
    const idleSinceMs = manager.execActivity().idleSinceMs;

    // Reset to its checkpoint, the session runs its bootstrap as bayma's own.
    const reset = manager.resetToCheckpoint(sessionId, ACTOR);
    while (manager.detail(sessionId).status !== "live_busy") await Bun.sleep(1);
    expect(manager.execActivity()).toEqual({
      execsRunning: 0,
      execsQueued: 0,
      running: [],
      idleSinceMs,
      generation: expect.any(Number),
    });
    transport.completeNext(sessionId);
    await reset;
    expect(manager.execActivity().idleSinceMs).toBe(idleSinceMs);
  });
});

test("a closed session's last exec still tells since when none has run", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(true);
    const manager = managerIn(dir, transport);
    const startedAtMs = manager.execActivity().idleSinceMs!;
    const sessionId = await createSession(manager, dir);
    // Later than the server started, on the clock execs end by.
    while (Date.now() <= startedAtMs) await Bun.sleep(1);
    await manager.submitExec(sessionId, ACTOR, "1");
    await Bun.sleep(0);
    const { finishedAtMs } = manager.execs(sessionId)[0]!;
    expect(finishedAtMs).toBeGreaterThan(startedAtMs);

    await manager.close(sessionId, ACTOR);
    expect(manager.execActivity()).toEqual({
      execsRunning: 0,
      execsQueued: 0,
      running: [],
      idleSinceMs: finishedAtMs!,
      generation: expect.any(Number),
    });
  });
});
