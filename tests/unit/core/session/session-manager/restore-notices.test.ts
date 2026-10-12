import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CheckpointStore,
  ExecHistoryStore,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  type ExecNotice,
  type ExecRecord,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import {
  PidReservingSnapshotter,
  SnapshottingTransport,
} from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

// What the session manager reports to the server's operator, on stderr, is
// not this file's concern.
let restoreStderr: () => void;

beforeEach(() => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  restoreStderr = () => stderr.mockRestore();
});

afterEach(() => restoreStderr());

function managerFor(
  dir: string,
  transport: SnapshottingTransport,
): SessionManager {
  return new SessionManager(
    new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
    new SessionCatalogStore(dir),
    new ExecHistoryStore(dir),
    new CheckpointStore(dir),
    {
      maxSessions: 8,
      warnUsagePercent: 75,
      defaultCols: 80,
      defaultRows: 24,
      processSnapshotter: new PidReservingSnapshotter(),
    },
    () => undefined,
  );
}

/** A checkpointed session whose server stopped, and the next server. */
async function restartedSession(
  dir: string,
  first: SnapshottingTransport,
  next: SnapshottingTransport,
): Promise<{ manager: SessionManager; sessionId: string }> {
  const stopped = managerFor(dir, first);
  const { sessionId } = await stopped.createWithPolicy(
    "actor_1",
    "restarted",
    dir,
    { durabilityMode: "checkpointed", initialCheckpoint: { answer: 41 } },
    "controller",
  );
  await stopped.shutdown();
  next.checkpointValue = { answer: 42 };
  const manager = managerFor(dir, next);
  await manager.loadCatalog();
  await manager.attach(sessionId, "actor_2", "controller");
  return { manager, sessionId };
}

/** Run two execs in turn, returning their records as the store keeps them. */
async function runTwo(
  manager: SessionManager,
  dir: string,
  sessionId: string,
): Promise<ExecRecord[]> {
  for (const code of ["1", "2"]) {
    await manager.submitExec(sessionId, "actor_2", code);
    await Bun.sleep(0);
  }
  return new ExecHistoryStore(dir).read(sessionId);
}

test("the first exec after a session came back whole is told so, and only it", async () => {
  await withTempDir(async (dir) => {
    const { manager, sessionId } = await restartedSession(
      dir,
      new SnapshottingTransport(),
      new SnapshottingTransport(),
    );

    const [told, untold] = await runTwo(manager, dir, sessionId);
    expect(told!.notice).toEqual({ returnedFrom: "process_snapshot" });
    expect(untold!.notice).toBeUndefined();
    expect(manager.exec(sessionId, told!.execId).notice).toEqual({
      returnedFrom: "process_snapshot",
    });
  });
});

test("the first exec after a session came back from its checkpoint is told so", async () => {
  await withTempDir(async (dir) => {
    for (const fail of [
      (transport: SnapshottingTransport) => {
        transport.snapshotFailure = "simulated dump failure";
      },
      (transport: SnapshottingTransport) => {
        transport.restoreFailure = "simulated restore failure";
      },
    ]) {
      const first = new SnapshottingTransport();
      const next = new SnapshottingTransport();
      fail(first);
      fail(next);
      const { manager, sessionId } = await restartedSession(dir, first, next);

      const [told, untold] = await runTwo(manager, dir, sessionId);
      expect(told!.notice).toEqual({ returnedFrom: "checkpoint" });
      expect(untold!.notice).toBeUndefined();
      await manager.close(sessionId, "actor_2");
    }
  });
});

test("a sandbox's restore is told to the exec still running or queued, else to the next, the latest restore's", async () => {
  await withTempDir(async (dir) => {
    const transport = new SnapshottingTransport(false);
    const manager = managerFor(dir, transport);
    const sessions: string[] = [];
    for (const title of ["running", "queued", "ended", "idle"]) {
      const { sessionId } = await manager.createWithPolicy(
        "actor_2",
        title,
        dir,
        { durabilityMode: "ephemeral" },
        "controller",
      );
      sessions.push(sessionId);
    }
    const [running, queued, ended, idle] = sessions as [
      string,
      string,
      string,
      string,
    ];
    const { execId: runningExec } = await manager.submitExec(
      running,
      "actor_2",
      "1",
    );
    await manager.submitExec(queued, "actor_2", "2");
    const { execId: queuedExec } = await manager.submitExec(
      queued,
      "actor_2",
      "3",
    );
    const { execId: endedExec } = await manager.submitExec(
      ended,
      "actor_2",
      "4",
    );
    // The restored sandbox runs before it hears it was restored: an exec may
    // end meanwhile, its result going to whoever still waits on it.
    transport.completeNext(ended);
    await Bun.sleep(0);
    manager.sandboxRestored(1_000);
    // A later restore, before the execs it told ended, tells of itself.
    manager.sandboxRestored(2_000);

    const told: ExecNotice = {
      returnedFrom: "sandbox_snapshot",
      snapshotAtMs: 2_000,
    };
    expect(manager.exec(running, runningExec).notice).toEqual(told);
    expect(manager.execs(queued).map(({ notice }) => notice)).toEqual([
      told,
      undefined,
    ]);
    expect(manager.exec(ended, endedExec).notice).toBeUndefined();
    expect(new ExecHistoryStore(dir).read(running)[0]!.notice).toEqual(told);
    for (let exec = 0; exec < 2; exec += 1) {
      transport.completeNext(queued);
      await Bun.sleep(0);
    }
    expect(manager.exec(queued, queuedExec).notice).toBeUndefined();
    for (const sessionId of [ended, idle]) {
      const { execId } = await manager.submitExec(sessionId, "actor_2", "5");
      expect(manager.exec(sessionId, execId).notice).toEqual(told);
    }
  });
});

test("a session told it came back from its checkpoint keeps that through a sandbox's restore", async () => {
  await withTempDir(async (dir) => {
    const first = new SnapshottingTransport();
    first.snapshotFailure = "simulated dump failure";
    const { manager, sessionId } = await restartedSession(
      dir,
      first,
      new SnapshottingTransport(),
    );
    await manager.recoverSession(sessionId, "actor_2");
    manager.sandboxRestored(1_000);

    const [told] = await runTwo(manager, dir, sessionId);
    expect(told!.notice).toEqual({ returnedFrom: "checkpoint" });
  });
});

test("a session that never left its server tells its execs nothing", async () => {
  await withTempDir(async (dir) => {
    const transport = new SnapshottingTransport();
    transport.checkpointValue = { answer: 42 };
    const manager = managerFor(dir, transport);
    const { sessionId } = await manager.createWithPolicy(
      "actor_2",
      "fresh",
      dir,
      { durabilityMode: "checkpointed" },
      "controller",
    );

    const records = await runTwo(manager, dir, sessionId);
    expect(records.map(({ notice }) => notice)).toEqual([undefined, undefined]);
  });
});
