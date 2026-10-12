import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CheckpointStore,
  ExecHistoryStore,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
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
