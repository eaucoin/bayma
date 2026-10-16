import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CheckpointStore,
  describeExecNotice,
  ExecHistoryStore,
  markSandboxResumed,
  markSandboxSaved,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  type ExecNotice,
  type ExecRecord,
  type RuntimeAdapter,
  type RuntimeMemoryBudget,
  type StartSessionInput,
  type TransportSessionHandle,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

// What the session manager reports to the server's operator, on stderr, kept
// for the tests that look at it.
let restoreStderr: () => void;
let reported: () => string[];

beforeEach(() => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  restoreStderr = () => stderr.mockRestore();
  reported = () => stderr.mock.calls.map(([chunk]) => String(chunk));
});

afterEach(() => {
  markSandboxResumed();
  restoreStderr();
});

const MIB = 1024 ** 2;
const KEEPS = "every cell it ran";
/** What every host holds of its own as it starts, unless a test says otherwise. */
const STARTED = 40 * MIB;
/** The pid of a session's first host. */
const FIRST = 1_000;

/** A runtime whose host keeps something of each cell, as C#'s and Go's do. */
const keeping: RuntimeAdapter = { ...bunAdapter, keepsOfEachCell: KEEPS };

/** A fake runtime that counts the hosts it starts, each of its own pid. */
class CountingTransport extends FakeTransport {
  readonly starts: number[] = [];

  override async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    const handle = await super.startSession(input);
    handle.pid = FIRST + this.starts.length;
    this.starts.push(handle.pid);
    return handle;
  }
}

interface Setup {
  manager: SessionManager;
  transport: CountingTransport;
  /** What each host holds of its own now, by its pid: STARTED unless set; untold where undefined. */
  held: Map<number, number | undefined>;
  /** What a host started again comes to hold past its start as the session's checkpoint is restored into it. */
  restoredHolds: number;
  /** The pids read, in turn. */
  read: number[];
}

function managerFor(
  dir: string,
  adapter: RuntimeAdapter,
  runtimeMemoryBudget?: RuntimeMemoryBudget,
  autoComplete = true,
): Setup {
  const transport = new CountingTransport(autoComplete);
  const setup: Setup = {
    manager: undefined as unknown as SessionManager,
    transport,
    held: new Map(),
    restoredHolds: 0,
    read: [],
  };
  setup.manager = new SessionManager(
    new RuntimeRegistry([{ adapter, transport }]),
    new SessionCatalogStore(dir),
    new ExecHistoryStore(dir),
    new CheckpointStore(dir),
    {
      maxSessions: 8,
      warnUsagePercent: 75,
      defaultCols: 80,
      defaultRows: 24,
      processSnapshotter: null,
      ...(runtimeMemoryBudget === undefined ? {} : { runtimeMemoryBudget }),
      hostMemoryBytes: (pid) => {
        const earlier = setup.read.includes(pid);
        setup.read.push(pid);
        if (setup.held.has(pid)) return setup.held.get(pid);
        // A host started again holds, once past its start, what the session's
        // checkpoint restored into it.
        return earlier && pid !== FIRST
          ? STARTED + setup.restoredHolds
          : STARTED;
      },
    },
    () => undefined,
  );
  return setup;
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Bun.sleep(0);
}

/** Runs `codes` in turn in the session, as the store then keeps them. */
async function run(
  manager: SessionManager,
  dir: string,
  sessionId: string,
  codes: readonly string[],
): Promise<ExecRecord[]> {
  for (const code of codes) {
    await manager.submitExec(sessionId, "actor_1", code);
    await settle();
  }
  return new ExecHistoryStore(dir).read(sessionId);
}

async function session(
  setup: Setup,
  dir: string,
  durabilityMode: "checkpointed" | "ephemeral",
): Promise<string> {
  if (durabilityMode === "checkpointed")
    setup.transport.checkpointValue = { answer: 42 };
  const { sessionId } = await setup.manager.createWithPolicy(
    "actor_1",
    "budgeted",
    dir,
    { durabilityMode },
    "controller",
  );
  return sessionId;
}

/** Has the session's first host come to hold `grown` more than it started with. */
function grow(setup: Setup, grown: number): void {
  setup.held.set(FIRST, STARTED + grown);
}

test("a C#-like host that grows past the budget once an exec has ended is started again from the checkpoint, and the next exec told why, and only it", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir, keeping, { keeping: 100 * MIB });
    const sessionId = await session(setup, dir, "checkpointed");
    grow(setup, 150 * MIB);
    const [ended, told, untold] = await run(setup.manager, dir, sessionId, [
      "1",
      "2",
      "3",
    ]);
    expect(setup.transport.starts.length).toBe(2);
    expect(ended!.notice).toBeUndefined();
    const notice: ExecNotice = {
      returnedFrom: "memory_budget",
      memory: {
        grewBytes: 150 * MIB,
        budgetBytes: 100 * MIB,
        keepsOfEachCell: KEEPS,
        from: "checkpoint",
      },
    };
    expect(told!.notice).toEqual(notice);
    expect(untold!.notice).toBeUndefined();
    expect(setup.manager.exec(sessionId, told!.execId).notice).toEqual(notice);
    expect(describeExecNotice(told!.notice!)).toBe(
      `bayma: this session's runtime came to hold 150 MiB more than it held as it started, past the server's runtime memory budget of 100 MiB, as it keeps ${KEEPS}, so it was started again from its checkpoint: only its checkpointed state survived, and the rest of its live state is gone.`,
    );
  });
});

test("the budget counts what a host comes to hold past what it held as it started, not what it holds", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir, keeping, { keeping: 100 * MIB });
    // It starts holding 3 GiB, and comes to hold no more.
    setup.held.set(FIRST, 3 * 1024 * MIB);
    const sessionId = await session(setup, dir, "checkpointed");
    await run(setup.manager, dir, sessionId, ["1", "2"]);
    expect(setup.transport.starts.length).toBe(1);
    expect(setup.read.length).toBe(3);
  });
});

test("an exec queued as the host was found past the budget is told why, as it runs on the host started again", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir, keeping, { keeping: 100 * MIB }, false);
    const sessionId = await session(setup, dir, "checkpointed");
    grow(setup, 150 * MIB);
    await setup.manager.submitExec(sessionId, "actor_1", "1");
    const queued = await setup.manager.submitExec(sessionId, "actor_1", "2");
    await settle();
    setup.transport.completeNext(sessionId);
    await settle();
    expect(setup.transport.starts.length).toBe(2);
    setup.transport.completeNext(sessionId);
    await settle();
    const told = setup.manager.exec(sessionId, queued.execId);
    expect(told.status).toBe("ok");
    expect(told.notice?.returnedFrom).toBe("memory_budget");
  });
});

test("a host past the budget whose session has no checkpoint committed is started again afresh, as the next exec is told", async () => {
  await withTempDir(async (dir) => {
    // An ephemeral session commits none, as no exec of a checkpointed one
    // ends without one.
    const setup = managerFor(dir, keeping, { keeping: 100 * MIB });
    const sessionId = await session(setup, dir, "ephemeral");
    grow(setup, 101 * MIB);
    const [, told] = await run(setup.manager, dir, sessionId, ["1", "2"]);
    expect(setup.transport.starts.length).toBe(2);
    expect(told!.notice?.memory?.from).toBe("fresh");
    expect(describeExecNotice(told!.notice!)).toBe(
      `bayma: this session's runtime came to hold 101 MiB more than it held as it started, past the server's runtime memory budget of 100 MiB, as it keeps ${KEEPS}, so it was started again afresh: the session had no checkpoint committed, and none of its state survived.`,
    );
  });
});

test("a host past the budget of a checkpointed session that has committed no checkpoint, its only exec having failed, is started again afresh, as the next exec is told", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir, keeping, { keeping: 100 * MIB }, false);
    const sessionId = await session(setup, dir, "checkpointed");
    grow(setup, 101 * MIB);
    const failed = await setup.manager.submitExec(sessionId, "actor_1", "1");
    await settle();
    // Its cell throws, and the runtime keeps the checkpoint the session had,
    // which is none.
    const prefix = setup.transport.pendingEventPrefix(sessionId);
    const host = setup.transport.requireSession(sessionId);
    host.writes.shift();
    host.promptCount += 1;
    setup.transport.emit(
      sessionId,
      [
        `${prefix}{"kind":"error","text":"thrown"}`,
        `${prefix}{"kind":"checkpoint-preserved"}`,
        `${prefix}{"kind":"done"}`,
        "> ",
        "",
      ].join("\n"),
    );
    await settle();
    expect(setup.manager.exec(sessionId, failed.execId).status).toBe("error");
    expect(setup.transport.starts.length).toBe(2);
    const told = await setup.manager.submitExec(sessionId, "actor_1", "2");
    await settle();
    setup.transport.completeNext(sessionId);
    await settle();
    const notice = setup.manager.exec(sessionId, told.execId).notice;
    expect(notice?.memory?.from).toBe("fresh");
    expect(describeExecNotice(notice!)).toBe(
      `bayma: this session's runtime came to hold 101 MiB more than it held as it started, past the server's runtime memory budget of 100 MiB, as it keeps ${KEEPS}, so it was started again afresh: the session had no checkpoint committed, and none of its state survived.`,
    );
  });
});

test("a host whose memory cannot be told, as it starts or once it has run, is reported once for each host, and only where the budget covers its runtime", async () => {
  await withTempDir(async (dir) => {
    const untoldReports = () =>
      reported().filter((line) =>
        line.includes(
          "says nothing of its memory the runtime memory budget can count",
        ),
      );
    // Untold as it starts.
    const fromStart = managerFor(dir, keeping, { keeping: 100 * MIB });
    fromStart.held.set(FIRST, undefined);
    const fromStartId = await session(fromStart, dir, "checkpointed");
    await run(fromStart.manager, dir, fromStartId, ["1", "2", "3"]);
    expect(fromStart.transport.starts.length).toBe(1);
    expect(untoldReports()).toHaveLength(1);
    expect(untoldReports()[0]).toInclude(
      `session ${fromStartId}'s bun host, pid ${FIRST}, says nothing of its memory the runtime memory budget can count, in its /proc smaps_rollup, status or smaps: the budget does not hold it`,
    );
    await fromStart.manager.close(fromStartId, "actor_1");

    // Untold once it has run, and its host, reset to the checkpoint, untold
    // again, as a host of its own.
    const later = managerFor(dir, keeping, { keeping: 100 * MIB });
    const laterId = await session(later, dir, "checkpointed");
    later.held.set(FIRST, undefined);
    await run(later.manager, dir, laterId, ["1", "2"]);
    expect(untoldReports()).toHaveLength(2);
    later.held.set(FIRST + 1, undefined);
    await later.manager.resetToCheckpoint(laterId, "actor_1");
    await run(later.manager, dir, laterId, ["3", "4"]);
    expect(later.transport.starts.length).toBe(2);
    expect(untoldReports()).toHaveLength(3);
    expect(untoldReports()[2]).toInclude(`pid ${FIRST + 1}`);
    await later.manager.close(laterId, "actor_1");

    // No budget: none.
    const unbudgeted = managerFor(dir, keeping, { keeping: 0 });
    unbudgeted.held.set(FIRST, undefined);
    const unbudgetedId = await session(unbudgeted, dir, "checkpointed");
    await run(unbudgeted.manager, dir, unbudgetedId, ["1"]);
    expect(untoldReports()).toHaveLength(3);
  });
});

test("a host its checkpoint restores already past the budget is not started again after every exec: the budget stands down for the session, its next exec told so, once", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir, keeping, { keeping: 100 * MIB });
    setup.restoredHolds = 120 * MIB;
    const sessionId = await session(setup, dir, "checkpointed");
    grow(setup, 150 * MIB);
    const records = await run(setup.manager, dir, sessionId, [
      "1",
      "2",
      "3",
      "4",
    ]);
    expect(setup.transport.starts.length).toBe(2);
    expect(records.map((record) => record.notice?.returnedFrom)).toEqual([
      undefined,
      "memory_budget",
      undefined,
      undefined,
    ]);
    expect(records[1]!.notice!.memory!.stoodDownBytes).toBe(120 * MIB);
    expect(describeExecNotice(records[1]!.notice!)).toEndWith(
      ", so it was started again from its checkpoint: only its checkpointed state survived, and the rest of its live state is gone. Restored, it already holds 120 MiB more than it started with, past the budget too, so the budget stands down for this session until it is closed.",
    );
  });
});

test("a runtime that keeps nothing of its cells has no budget by default, however much its host comes to hold, as a Python session holding a model does", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir, bunAdapter);
    const sessionId = await session(setup, dir, "checkpointed");
    grow(setup, 10_000 * MIB);
    const records = await run(setup.manager, dir, sessionId, ["1", "2"]);
    expect(setup.transport.starts.length).toBe(1);
    expect(setup.read).toEqual([]);
    expect(records.map((record) => record.notice)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

test("a runtime that keeps nothing of its cells is held to a budget given for all runtimes or for it, its own before all's, the notice saying only what it grew by", async () => {
  await withTempDir(async (dir) => {
    for (const budget of [
      { all: 100 * MIB },
      { runtimes: { bun: 100 * MIB } },
      { all: 0, runtimes: { bun: 100 * MIB } },
    ] satisfies RuntimeMemoryBudget[]) {
      const setup = managerFor(dir, bunAdapter, budget);
      const sessionId = await session(setup, dir, "checkpointed");
      grow(setup, 150 * MIB);
      const [, told] = await run(setup.manager, dir, sessionId, ["1", "2"]);
      expect(setup.transport.starts.length).toBe(2);
      expect(told!.notice).toEqual({
        returnedFrom: "memory_budget",
        memory: {
          grewBytes: 150 * MIB,
          budgetBytes: 100 * MIB,
          from: "checkpoint",
        },
      });
      expect(describeExecNotice(told!.notice!)).toBe(
        "bayma: this session's runtime came to hold 150 MiB more than it held as it started, past the server's runtime memory budget of 100 MiB, so it was started again from its checkpoint: only its checkpointed state survived, and the rest of its live state is gone.",
      );
      await setup.manager.close(sessionId, "actor_1");
    }
    // Its own, none, before all's.
    const own = managerFor(dir, bunAdapter, {
      all: 100 * MIB,
      runtimes: { bun: 0 },
    });
    const ownId = await session(own, dir, "checkpointed");
    grow(own, 150 * MIB);
    await run(own.manager, dir, ownId, ["1", "2"]);
    expect(own.transport.starts.length).toBe(1);
  });
});

test("a host within the budget, one whose memory cannot be told, one whose exec ends while the sandbox is saved, and no budget, are left as they are", async () => {
  await withTempDir(async (dir) => {
    // Within the budget, at it exactly.
    const within = managerFor(dir, keeping, { keeping: 100 * MIB });
    const withinId = await session(within, dir, "checkpointed");
    grow(within, 100 * MIB);
    const records = await run(within.manager, dir, withinId, ["1", "2"]);
    expect(within.transport.starts.length).toBe(1);
    expect(records.map((record) => record.notice)).toEqual([
      undefined,
      undefined,
    ]);
    await within.manager.close(withinId, "actor_1");

    // Its memory untold.
    const untold = managerFor(dir, keeping, { keeping: 100 * MIB });
    const untoldId = await session(untold, dir, "checkpointed");
    untold.held.set(FIRST, undefined);
    await run(untold.manager, dir, untoldId, ["1", "2"]);
    expect(untold.transport.starts.length).toBe(1);
    await untold.manager.close(untoldId, "actor_1");

    // Its exec ending as the sandbox is saved.
    const saved = managerFor(dir, keeping, { keeping: 100 * MIB }, false);
    const savedId = await session(saved, dir, "checkpointed");
    grow(saved, 150 * MIB);
    await saved.manager.submitExec(savedId, "actor_1", "1");
    await settle();
    markSandboxSaved();
    saved.transport.completeNext(savedId);
    await settle();
    markSandboxResumed();
    await settle();
    expect(saved.transport.starts.length).toBe(1);
    await saved.manager.close(savedId, "actor_1");

    // No budget: never measured.
    const unbudgeted = managerFor(dir, keeping, { keeping: 0 });
    const unbudgetedId = await session(unbudgeted, dir, "checkpointed");
    grow(unbudgeted, 10_000 * MIB);
    await run(unbudgeted.manager, dir, unbudgetedId, ["1", "2"]);
    expect(unbudgeted.transport.starts.length).toBe(1);
    expect(unbudgeted.read).toEqual([]);
  });
});

test("the budget of a runtime that keeps something of each cell is 2 GiB unless given, and each budget a whole number of bytes", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir, keeping);
    const sessionId = await session(setup, dir, "checkpointed");
    grow(setup, 2048 * MIB);
    await run(setup.manager, dir, sessionId, ["1"]);
    expect(setup.transport.starts.length).toBe(1);
    grow(setup, 2048 * MIB + 1);
    await run(setup.manager, dir, sessionId, ["2"]);
    expect(setup.transport.starts.length).toBe(2);
    for (const budget of [
      { keeping: -1 },
      { all: 1.5 },
      { runtimes: { bun: Number.NaN } },
    ])
      expect(() => managerFor(dir, keeping, budget)).toThrow(
        "a runtime memory budget must be a whole number of bytes, 0 or more",
      );
  });
});
