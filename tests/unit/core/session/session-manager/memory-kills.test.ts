import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CheckpointStore,
  describeExecNotice,
  ExecHistoryStore,
  markSandboxResumed,
  markSandboxSaved,
  MEMORY_KILLS_APART_MS,
  RuntimeMemoryKilled,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  type ExecNotice,
  type RuntimeAdapter,
  type StartSessionInput,
  type TransportSessionHandle,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

// What the session manager reports to the server's operator, on stderr, kept
// out of the test's output.
let restoreStderr: () => void;

beforeEach(() => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  restoreStderr = () => stderr.mockRestore();
});

afterEach(() => restoreStderr());

/**
 * A fake runtime that counts the hosts it starts, and whose resize, while
 * `resizing` is set, waits for it, holding its session's mutations back.
 */
class CountingTransport extends FakeTransport {
  starts = 0;
  resizing?: Promise<void>;

  override async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    const handle = await super.startSession(input);
    handle.pid = FIRST + this.starts;
    this.starts += 1;
    return handle;
  }

  override async resize(
    handle: TransportSessionHandle,
    size: { cols: number; rows: number },
  ): Promise<void> {
    if (this.resizing) return this.resizing;
    return super.resize(handle, size);
  }
}

/** The pid of a session's first host. */
const FIRST = 1_000;

/** A runtime whose host keeps something of each cell, which the runtime memory budget covers. */
const keeping: RuntimeAdapter = {
  ...bunAdapter,
  keepsOfEachCell: "every cell",
};

function managerFor(
  dir: string,
  adapter: RuntimeAdapter = bunAdapter,
  hostMemoryBytes?: (pid: number) => number | undefined,
): {
  manager: SessionManager;
  transport: CountingTransport;
} {
  const transport = new CountingTransport(false);
  const manager = new SessionManager(
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
      ...(hostMemoryBytes === undefined ? {} : { hostMemoryBytes }),
    },
    () => undefined,
  );
  return { manager, transport };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Bun.sleep(0);
}

/** How a transport tells a runtime the kernel killed for its memory, as a container's cgroup of 768Mi counts it. */
function killed(sessionId: string): RuntimeMemoryKilled {
  return new RuntimeMemoryKilled(
    `transport session ${sessionId} ran out of its memory (768Mi) and was killed by the kernel (code=null, signal=SIGKILL)`,
    { limit: "768Mi" },
  );
}

/** A session of `durabilityMode` whose first exec has ended, committing a checkpoint where it keeps them. */
async function session(
  setup: ReturnType<typeof managerFor>,
  dir: string,
  durabilityMode: "checkpointed" | "ephemeral",
): Promise<string> {
  if (durabilityMode === "checkpointed")
    setup.transport.checkpointValue = { answer: 42 };
  const { sessionId } = await setup.manager.createWithPolicy(
    "actor_1",
    "killed",
    dir,
    { durabilityMode },
    "controller",
  );
  await setup.manager.submitExec(sessionId, "actor_1", "1");
  await settle();
  setup.transport.completeNext(sessionId);
  await settle();
  return sessionId;
}

test("a runtime the kernel kills for its memory mid-exec comes back from its checkpoint: the exec ends saying why, and the exec queued meanwhile runs on the runtime started again, told so", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "checkpointed");
    const committedAtMs = new CheckpointStore(dir).read(sessionId)!.updatedAtMs;
    const hog = await setup.manager.submitExec(sessionId, "actor_1", "hog()");
    const queued = await setup.manager.submitExec(sessionId, "actor_1", "2");
    await settle();

    setup.transport.exit(sessionId, killed(sessionId));
    await settle();
    const ended = setup.manager.exec(sessionId, hog.execId);
    expect(ended.status).toBe("error");
    expect(ended.messages.at(-1)?.text).toInclude(
      "ran out of its memory (768Mi) and was killed by the kernel (code=null, signal=SIGKILL)",
    );
    expect(setup.transport.starts).toBe(2);
    expect(setup.manager.detail(sessionId).status).not.toBe("quarantined");

    setup.transport.completeNext(sessionId);
    await settle();
    const told = setup.manager.exec(sessionId, queued.execId);
    expect(told.status).toBe("ok");
    const notice: ExecNotice = {
      returnedFrom: "memory_kill",
      memoryKill: {
        limit: "768Mi",
        from: "checkpoint",
        checkpointAtMs: committedAtMs,
      },
    };
    expect(told.notice).toEqual(notice);
    expect(new ExecHistoryStore(dir).read(sessionId).at(-1)?.notice).toEqual(
      notice,
    );
    expect(describeExecNotice(notice)).toBe(
      `bayma: this session's runtime ran out of its container's memory (768Mi) and was killed by the kernel, so it was started again from its checkpoint committed at ${new Date(committedAtMs).toISOString()}: only its checkpointed state survived, and the rest of its live state is gone.`,
    );
  });
});

test("a runtime the kernel kills for its memory while idle, of a session that commits no checkpoint, comes back afresh, as the next exec submitted is told", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "ephemeral");
    setup.transport.exit(sessionId, killed(sessionId));
    await settle();
    expect(setup.transport.starts).toBe(2);

    const next = await setup.manager.submitExec(sessionId, "actor_1", "2");
    await settle();
    setup.transport.completeNext(sessionId);
    await settle();
    const told = setup.manager.exec(sessionId, next.execId);
    expect(told.status).toBe("ok");
    expect(told.notice).toEqual({
      returnedFrom: "memory_kill",
      memoryKill: { limit: "768Mi", from: "fresh" },
    });
    expect(describeExecNotice(told.notice!)).toBe(
      "bayma: this session's runtime ran out of its container's memory (768Mi) and was killed by the kernel, so it was started again afresh: the session had no checkpoint committed, and none of its state survived.",
    );
  });
});

test("a runtime the kernel kills for its memory again within MEMORY_KILLS_APART_MS of the last, by the monotonic clock, is not started again, its session quarantined saying so; one killed later comes back again", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "checkpointed");
    let monotonicMs = performance.now();
    let wallMs = Date.now();
    const monotonic = spyOn(performance, "now").mockImplementation(
      () => monotonicMs,
    );
    const wall = spyOn(Date, "now").mockImplementation(() => wallMs);
    try {
      setup.transport.exit(sessionId, killed(sessionId));
      await settle();
      expect(setup.transport.starts).toBe(2);

      // Past the bound, the wall clock set back meanwhile: it comes back again.
      monotonicMs += MEMORY_KILLS_APART_MS;
      wallMs -= 3_600_000;
      setup.transport.exit(sessionId, killed(sessionId));
      await settle();
      expect(setup.transport.starts).toBe(3);
      expect(setup.manager.detail(sessionId).status).not.toBe("quarantined");

      // Within it, the wall clock set forth an hour meanwhile: it does not.
      monotonicMs += MEMORY_KILLS_APART_MS - 1;
      wallMs += 2 * 3_600_000;
      setup.transport.exit(sessionId, killed(sessionId));
      await settle();
      expect(setup.transport.starts).toBe(3);
      const quarantined = setup.manager.detail(sessionId);
      expect(quarantined.status).toBe("quarantined");
      expect(quarantined.quarantineReason).toInclude(
        "ran out of its memory (768Mi) and was killed by the kernel",
      );
      expect(quarantined.quarantineReason).toInclude(
        `the kernel killed it for its memory again within ${MEMORY_KILLS_APART_MS / 1_000} s of the last time, so it is not started again`,
      );
    } finally {
      wall.mockRestore();
      monotonic.mockRestore();
    }
  });
});

/** Holds back the session's mutations, as a resize in flight does, until the returned function is called. */
function holdMutations(
  setup: ReturnType<typeof managerFor>,
  sessionId: string,
): () => Promise<void> {
  let resized!: () => void;
  setup.transport.resizing = new Promise((resolve) => (resized = resolve));
  const resizing = setup.manager.resize(sessionId, "actor_1", 100, 30);
  return async () => {
    resized();
    setup.transport.resizing = undefined;
    await resizing;
    await settle();
  };
}

test("a session closed between the kill and the start again stays closed: no runtime is started for it", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "checkpointed");
    const release = holdMutations(setup, sessionId);
    const closing = setup.manager.close(sessionId, "actor_1");
    await settle();
    setup.transport.exit(sessionId, killed(sessionId));
    await settle();
    await release();
    await closing;
    await settle();
    expect(setup.transport.starts).toBe(1);
    expect(setup.manager.list().map(({ sessionId: id }) => id)).not.toContain(
      sessionId,
    );
  });
});

test("a runtime the session started anew between the kill and the start again, as a reset to its checkpoint does, is not started again on top", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "checkpointed");
    const release = holdMutations(setup, sessionId);
    const resetting = setup.manager.resetToCheckpoint(sessionId, "actor_1");
    await settle();
    setup.transport.exit(sessionId, killed(sessionId));
    await settle();
    await release();
    await resetting;
    await settle();
    expect(setup.transport.starts).toBe(2);
    expect(setup.manager.detail(sessionId).status).toBe("live_idle");
  });
});

test("a runtime the kernel kills while the sandbox is saved is started again only once the sandbox runs on", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "checkpointed");
    markSandboxSaved();
    try {
      setup.transport.exit(sessionId, killed(sessionId));
      await settle();
      expect(setup.transport.starts).toBe(1);
      expect(setup.manager.detail(sessionId).status).toBe("recovering");
    } finally {
      markSandboxResumed();
    }
    await settle();
    expect(setup.transport.starts).toBe(2);
    expect(setup.manager.detail(sessionId).status).toBe("live_idle");
  });
});

test("an exec's memory_kill notice is kept in its session's history as it was, and read back so", async () => {
  await withTempDir(async (dir) => {
    const store = new ExecHistoryStore(dir);
    const notices: ExecNotice[] = [
      {
        returnedFrom: "memory_kill",
        memoryKill: { limit: "768Mi", from: "checkpoint", checkpointAtMs: 5 },
      },
      {
        returnedFrom: "memory_kill",
        memoryKill: { limit: null, from: "fresh" },
      },
    ];
    store.write(
      "sess_kept",
      notices.map((notice, index) => ({
        execId: `exec_${index}`,
        code: "1",
        status: "ok" as const,
        submittedAtMs: 1,
        startedAtMs: 1,
        finishedAtMs: 2,
        durationMs: 1,
        notice,
        messages: [],
      })),
    );
    expect(
      new ExecHistoryStore(dir).read("sess_kept").map(({ notice }) => notice),
    ).toEqual(notices);
  });
});

test("execs queued, or submitted, while the runtime the kernel killed waits to be started again start on none, but on the runtime started again", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "checkpointed");
    await setup.manager.submitExec(sessionId, "actor_1", "hog()");
    const queued = await setup.manager.submitExec(sessionId, "actor_1", "2");
    await settle();
    // A resize in flight holds back the session's mutations: the one that
    // starts the runtime again, and an exec submitted meanwhile.
    let resized!: () => void;
    setup.transport.resizing = new Promise((resolve) => (resized = resolve));
    const resizing = setup.manager.resize(sessionId, "actor_1", 100, 30);
    const submitting = setup.manager.submitExec(sessionId, "actor_1", "3");
    await settle();

    setup.transport.exit(sessionId, killed(sessionId));
    await settle();
    expect(setup.manager.exec(sessionId, queued.execId).status).toBe("queued");
    resized();
    await resizing;
    const submitted = await submitting;
    await settle();
    expect(setup.transport.starts).toBe(2);
    for (const _ of [queued, submitted]) {
      setup.transport.completeNext(sessionId);
      await settle();
    }
    expect(
      [queued, submitted].map(
        ({ execId }) => setup.manager.exec(sessionId, execId).status,
      ),
    ).toEqual(["ok", "ok"]);
    expect(setup.manager.detail(sessionId).status).not.toBe("quarantined");
  });
});

test("the runtime memory budget never counts a host the kernel killed, as it would report a host gone, or one that took its pid, but the host started again", async () => {
  await withTempDir(async (dir) => {
    const read: number[] = [];
    const setup = managerFor(dir, keeping, (pid) => {
      read.push(pid);
      return 40 * 1024 ** 2;
    });
    const sessionId = await session(setup, dir, "checkpointed");
    await setup.manager.submitExec(sessionId, "actor_1", "hog()");
    await settle();
    read.length = 0;
    // Its start again held back, as the exec the kernel killed it in ends.
    let resized!: () => void;
    setup.transport.resizing = new Promise((resolve) => (resized = resolve));
    const resizing = setup.manager.resize(sessionId, "actor_1", 100, 30);
    await settle();

    setup.transport.exit(sessionId, killed(sessionId));
    await settle();
    resized();
    await resizing;
    await settle();
    expect(setup.transport.starts).toBe(2);
    expect(read).not.toContain(FIRST);
  });
});

test("a runtime that exits otherwise is quarantined, as before", async () => {
  await withTempDir(async (dir) => {
    const setup = managerFor(dir);
    const sessionId = await session(setup, dir, "checkpointed");
    setup.transport.exit(sessionId);
    await settle();
    expect(setup.transport.starts).toBe(1);
    expect(setup.manager.detail(sessionId).status).toBe("quarantined");
  });
});
