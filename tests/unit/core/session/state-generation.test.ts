import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join, relative } from "node:path";
import type { TransportSessionHandle } from "@bayma/core";
import {
  CheckpointStore,
  ExecHistoryStore,
  execFilePath,
  LAST_SAVE_FILE,
  procHidepid,
  SandboxSaveOutlived,
  StateGenerationNotMoved,
  writeLastSave,
  markSandboxResumed,
  markSandboxSaved,
  readStateGeneration,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  STATE_GENERATION_FILE,
  StateGeneration,
  type SessionEventSink,
  type StateGenerationSyncs,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import {
  FakeTransport,
  PidReservingSnapshotter,
  SnapshottingTransport,
} from "../../../support/fake-transport.ts";
import { withTempDir } from "../../../support/temp.ts";

// The state generation (packages/core/src/session/state-generation.ts): on
// the disk before any client is told of a discrete change, and what a save
// left running may be restored at.

const ACTOR = "actor_1";

afterEach(() => markSandboxResumed());

/**
 * What happened, in order: each sync of the generation, and each event told.
 */
type Logged = "sync" | string;

/**
 * A generation in `dir` whose syncs are logged in `log`, as they reach the
 * disk.
 */
function loggedGeneration(dir: string, log: Logged[]): StateGeneration {
  return new StateGeneration(dir, {
    file: () => log.push("sync"),
    directory: () => undefined,
  });
}

function managerIn(
  dir: string,
  transport: FakeTransport,
  emit: SessionEventSink,
  generation?: StateGeneration,
): SessionManager {
  return new SessionManager(
    new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
    new SessionCatalogStore(dir),
    new ExecHistoryStore(dir),
    new CheckpointStore(dir),
    { maxSessions: 8, warnUsagePercent: 75, defaultCols: 80, defaultRows: 24 },
    emit,
    generation,
  );
}

test("the generation is a small file of its own, moved on in place and on the disk once each bump returns", async () => {
  await withTempDir(async (dir) => {
    const syncs: string[] = [];
    const generation = new StateGeneration(dir, {
      file: () => syncs.push("file"),
      directory: () => syncs.push("directory"),
    });
    expect(generation.bump()).toBe(1);
    expect(generation.bump()).toBe(2);
    // Its directory synced once, as the file was made; the file at each write.
    expect(syncs).toEqual(["file", "directory", "file", "file"]);
    const path = join(dir, STATE_GENERATION_FILE);
    expect(statSync(path).size).toBe(128);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      schemaVersion: 1,
      generation: 2,
    });
    generation.close();
    // Opened again, as by the next server, it goes on from there.
    const next = new StateGeneration(dir);
    expect(next.bump()).toBe(3);
    next.close();
    expect(readStateGeneration(dir)).toBe(3);
  });
});

test("a bump that cannot reach the disk throws and leaves the generation where it was", async () => {
  await withTempDir(async (dir) => {
    let failing = false;
    const generation = new StateGeneration(dir, {
      file: () => {
        if (failing) throw Object.assign(new Error("EIO"), { code: "EIO" });
      },
      directory: () => undefined,
    });
    generation.bump();
    failing = true;
    expect(() => generation.bump()).toThrow("EIO");
    expect(generation.current).toBe(1);
    generation.close();
  });
});

test("a directory a filesystem cannot sync says EINVAL, which alone is borne", async () => {
  for (const [code, borne] of [
    ["EINVAL", true],
    ["EIO", false],
  ] as const) {
    await withTempDir(async (dir) => {
      const syncs: StateGenerationSyncs = {
        file: () => undefined,
        directory: () => {
          throw Object.assign(new Error(code), { code });
        },
      };
      const generation = new StateGeneration(dir, syncs);
      if (borne) expect(generation.bump()).toBe(1);
      else expect(() => generation.bump()).toThrow(code);
      generation.close();
    });
  }
});

test("a generation file of another schema, or none that parses, is refused", async () => {
  for (const text of [
    '{"schemaVersion":2,"generation":4}',
    '{"schemaVersion":1,"generation":-1}',
    '{"schemaVersion":1,"generation":4,"more":true}',
    "{",
  ]) {
    await withTempDir(async (dir) => {
      writeFileSync(join(dir, STATE_GENERATION_FILE), text);
      expect(() => readStateGeneration(dir)).toThrow();
      expect(() => new StateGeneration(dir).bump()).toThrow();
    });
  }
});

test("every discrete change is on the disk before its event is told, and an exec's output moves nothing", async () => {
  await withTempDir(async (dir) => {
    const log: Logged[] = [];
    const transport = new FakeTransport(false);
    transport.checkpointValue = { saved: 1 };
    const manager = managerIn(
      dir,
      transport,
      ({ event }) => log.push(event.type),
      loggedGeneration(dir, log),
    );
    await manager.loadCatalog();
    // The file made, then the start's bump.
    expect(log).toEqual(["sync", "sync"]);

    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "fenced",
      dir,
      { durabilityMode: "checkpointed" },
      "controller",
    );
    log.length = 0;
    const before = manager.execActivity().generation;
    await manager.submitExec(sessionId, ACTOR, "1");
    // Submitted, then started: a bump before each is told.
    expect(manager.execActivity().generation).toBe(before + 2);
    transport.emit(
      sessionId,
      `${transport.pendingEventPrefix(sessionId)}{"kind":"stdout","text":"out"}\n`,
    );
    transport.completeNext(sessionId);
    await Bun.sleep(0);
    await manager.submitExec(sessionId, ACTOR, "for (;;) {}");
    await manager.interrupt(sessionId, ACTOR);
    await manager.resetToCheckpoint(sessionId, ACTOR).catch(() => undefined);
    await manager.close(sessionId, ACTOR);

    // Each event a client is told of a discrete change follows a sync of its
    // own.
    const DISCRETE = new Set([
      "session/started",
      "exec/started",
      "exec/finished",
      "session/checkpointCommitted",
      "session/runtimeRecycled",
      "session/quarantined",
      "session/closed",
    ]);
    let unsynced = 0;
    const tellings: string[] = [];
    for (const entry of log) {
      if (entry === "sync") unsynced += 1;
      else if (DISCRETE.has(entry)) {
        tellings.push(entry);
        expect({ entry, synced: unsynced > 0 }).toEqual({
          entry,
          synced: true,
        });
        unsynced = 0;
      }
    }
    expect(tellings).toEqual(
      expect.arrayContaining([
        "exec/started",
        "session/checkpointCommitted",
        "exec/finished",
        "session/closed",
      ]),
    );
    // An exec's output is told, and syncs nothing.
    const output = log.indexOf("exec/stdout");
    expect(output).toBeGreaterThan(-1);
    expect(log[output - 1]).not.toBe("sync");
  });
});

test("a host exit that ends an exec, and a quarantine, are on the disk before they are told", async () => {
  await withTempDir(async (dir) => {
    const log: Logged[] = [];
    const transport = new FakeTransport(false);
    const manager = managerIn(
      dir,
      transport,
      ({ event }) => log.push(event.type),
      loggedGeneration(dir, log),
    );
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "exits",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    await manager.submitExec(sessionId, ACTOR, "process.exit()");
    log.length = 0;
    transport.exit(sessionId);
    expect(log.slice(0, 3)).toEqual(["sync", "exec/error", "exec/finished"]);
    expect(log).toContain("session/quarantined");
  });
});

test("a save racing a submission says what it caught, and starts no exec until the server runs on", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = managerIn(dir, transport, () => undefined);
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "saved",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    const running = await manager.submitExec(sessionId, ACTOR, "1");
    markSandboxSaved();
    const caught = manager.sandboxSaving();
    expect(caught.running).toEqual([{ sessionId, execId: running.execId }]);
    expect(JSON.parse(readFileSync(join(dir, LAST_SAVE_FILE), "utf8"))).toEqual(
      { schemaVersion: 1, ...caught },
    );

    // Submitted while saved, behind the one running, which then ends: the
    // next does not start, so what the save caught stays what runs.
    const queued = await manager.submitExec(sessionId, ACTOR, "2");
    transport.completeNext(sessionId);
    await Bun.sleep(10);
    expect(
      manager.execs(sessionId).find(({ execId }) => execId === queued.execId)
        ?.status,
    ).toBe("queued");
    expect(manager.execActivity().running).toEqual([]);

    markSandboxResumed();
    await Bun.sleep(10);
    expect(manager.execActivity().running).toEqual([
      { sessionId, execId: queued.execId },
    ]);
  });
});

test("a restore is refused where the state directory moved on since the save, or its generation cannot be read", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = managerIn(dir, transport, () => undefined);
    await manager.loadCatalog();
    markSandboxSaved();
    manager.sandboxSaving();
    // Nothing since: the save restores.
    expect(() => manager.assertSandboxRestorable()).not.toThrow();

    // The sandbox ran on past the save, and moved the generation on.
    const ranOn = new StateGeneration(dir);
    ranOn.bump();
    ranOn.close();
    expect(() => manager.assertSandboxRestorable()).toThrow(
      "the state directory has moved on since this save",
    );
    for (const text of ['{"schemaVersion":2,"generation":1}', "{"]) {
      writeFileSync(join(dir, STATE_GENERATION_FILE), text);
      expect(() => manager.assertSandboxRestorable()).toThrow(
        "the state generation cannot be read",
      );
    }
  });
});

test("a fresh start empties the sessions' scratch directories once its bump is on the disk, killing what still maps a file there", async () => {
  await withTempDir(async (dir) => {
    // A checkpointed session the server before left, and its scratch, where
    // a host of that server goes on mapping its plugin.
    const before = managerIn(dir, new FakeTransport(false), () => undefined);
    await before.loadCatalog();
    const { sessionId } = await before.createWithPolicy(
      ACTOR,
      "left",
      dir,
      { durabilityMode: "checkpointed" },
      "controller",
    );
    await before.shutdown();
    const module = join(dir, "scratch", sessionId, "go", "41-0011223344556677");
    mkdirSync(join(module, "plugins"), { recursive: true });
    const plugin = join(module, "plugins", "c0001.so");
    writeFileSync(plugin, Buffer.alloc(4096, 1));
    const mapper = (path: string) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `const mapped = Bun.mmap(${JSON.stringify(path)}); console.log("mapped"); setInterval(() => mapped[0], 1000);`,
        ],
        { stdout: "pipe" },
      );
    const host = mapper(plugin);
    // A process that maps a file elsewhere, which is no host's.
    const elsewhere = join(dir, "elsewhere.so");
    writeFileSync(elsewhere, Buffer.alloc(4096, 1));
    const other = mapper(elsewhere);
    for (const spawned of [host, other])
      await spawned.stdout.getReader().read();
    const log: Logged[] = [];
    const manager = managerIn(
      dir,
      new FakeTransport(false),
      () => undefined,
      new StateGeneration(dir, {
        file: () =>
          log.push(
            existsSync(plugin)
              ? "sync, the plugin there"
              : "sync, the plugin gone",
          ),
        directory: () => undefined,
      }),
    );
    await manager.loadCatalog();
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((entry) => entry === "sync, the plugin there")).toBe(true);
    expect(await host.exited).not.toBe(0);
    expect(host.signalCode).toBe("SIGKILL");
    expect(readdirSync(join(dir, "scratch", sessionId))).toEqual([]);
    // What maps no file there is left alone.
    expect(other.killed).toBe(false);
    expect(other.exitCode).toBeNull();
    other.kill();
    await manager.shutdown();
  });
});

test("a fresh start keeps the scratch directory of a session whose process snapshot it restores, which its processes map, killing what of the server before still maps it", async () => {
  await withTempDir(async (dir) => {
    const snapshotting = (transport: SnapshottingTransport) =>
      new SessionManager(
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
    const before = snapshotting(new SnapshottingTransport());
    const { sessionId } = await before.createWithPolicy(
      ACTOR,
      "dumped",
      dir,
      { durabilityMode: "checkpointed" },
      "controller",
    );
    await before.shutdown();
    const mapped = join(dir, "scratch", sessionId, "libcode.so");
    writeFileSync(mapped, Buffer.alloc(4096, 1));
    // A host of the server before, still mapping the file as it exits: killed,
    // as the snapshot's restore makes processes of its own.
    const host = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const mapped = Bun.mmap(${JSON.stringify(mapped)}); console.log("mapped"); setInterval(() => mapped[0], 1000);`,
      ],
      { stdout: "pipe" },
    );
    await host.stdout.getReader().read();
    const next = snapshotting(new SnapshottingTransport());
    await next.loadCatalog();
    expect(await host.exited).not.toBe(0);
    expect(host.signalCode).toBe("SIGKILL");
    expect(readFileSync(mapped)).toEqual(Buffer.alloc(4096, 1));
    await next.shutdown();
  });
});

/**
 * Of what `log` holds of `told`, each event that does not follow a sync of its
 * own: with only connections' events and what follows a told event in its
 * wake (its status, its output) between them.
 */
function eachSyncedBefore(
  log: readonly Logged[],
  told: ReadonlySet<string>,
): string[] {
  const between = new Set([
    "session/pressureWarning",
    "session/actorJoined",
    "session/actorLeft",
    "session/controllerChanged",
    "session/statusChanged",
    "exec/ptyDelta",
    "exec/stdout",
    "exec/stderr",
    "exec/error",
  ]);
  const unsynced: string[] = [];
  log.forEach((entry, index) => {
    if (!told.has(entry)) return;
    let before = index - 1;
    while (before >= 0 && between.has(log[before]!)) before -= 1;
    if (log[before] !== "sync") unsynced.push(entry);
  });
  return unsynced;
}

test("a generation another server moved on is stale: every bump of this one throws, from the first that finds it", async () => {
  await withTempDir(async (dir) => {
    const first = new StateGeneration(dir);
    expect(first.bump()).toBe(1);
    // The sandbox saved live ran on, and moved it on, before this one was
    // restored.
    const ranOn = new StateGeneration(dir);
    expect(ranOn.bump()).toBe(2);
    expect(ranOn.bump()).toBe(3);
    ranOn.close();
    expect(() => first.bump()).toThrow(StateGenerationNotMoved);
    expect(() => first.bump()).toThrow(
      "the state directory's generation is 3 on the disk, where this server last wrote 1",
    );
    // It never goes backwards.
    expect(readStateGeneration(dir)).toBe(3);
    first.close();
  });
});

test("a restored server that would change anything before its restore is told is refused, and its restore too", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = managerIn(dir, transport, () => undefined);
    await manager.loadCatalog();
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "restored",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    markSandboxSaved();
    manager.sandboxSaving();
    // The sandbox saved live ran on.
    const ranOn = new StateGeneration(dir);
    ranOn.bump();
    ranOn.close();
    markSandboxResumed();
    // Restored, it runs before its hook arrives: what it would change is not.
    await expect(manager.submitExec(sessionId, ACTOR, "1")).rejects.toThrow(
      StateGenerationNotMoved,
    );
    expect(() => manager.assertSandboxRestorable()).toThrow(
      SandboxSaveOutlived,
    );
    expect(readStateGeneration(dir)).toBe(
      manager.execActivity().generation + 1,
    );
  });
});

test("an eviction, a failed checkpoint and a resize are on the disk before they are told", async () => {
  await withTempDir(async (dir) => {
    const log: Logged[] = [];
    const transport = new FakeTransport(false);
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
      new SessionCatalogStore(dir),
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
      {
        maxSessions: 1,
        warnUsagePercent: 100,
        defaultCols: 80,
        defaultRows: 24,
      },
      ({ event }) => log.push(event.type),
      loggedGeneration(dir, log),
    );
    await manager.loadCatalog();
    // Checkpointed, its exec ends with no checkpoint: its checkpoint fails.
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "checkpointed",
      dir,
      { durabilityMode: "checkpointed" },
      "controller",
    );
    const resized = manager.execActivity().generation;
    await manager.resize(sessionId, ACTOR, 100, 30);
    expect(manager.execActivity().generation).toBe(resized + 1);
    await manager.submitExec(sessionId, ACTOR, "1");
    transport.completeNext(sessionId);
    await Bun.sleep(0);
    expect(log).toContain("session/checkpointFailed");
    // One live session beside it, which no client controls, then another
    // beyond the most sessions: the live one is evicted.
    await manager.createWithPolicy(
      ACTOR,
      "live",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    await manager.releaseActor(ACTOR);
    await manager.createWithPolicy(
      ACTOR,
      "next",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    expect(log).toContain("session/evictionScheduled");
    expect(
      eachSyncedBefore(
        log,
        new Set([
          "session/checkpointFailed",
          "session/evictionScheduled",
          "session/closed",
          "session/quarantined",
        ]),
      ),
    ).toEqual([]);
  });
});

test("a session recovered by the next server is on the disk before its recovery is told", async () => {
  await withTempDir(async (dir) => {
    const before = managerIn(dir, new FakeTransport(true), () => undefined);
    await before.loadCatalog();
    const { sessionId } = await before.createWithPolicy(
      ACTOR,
      "recovered",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: {} },
      "controller",
    );
    await before.shutdown();
    const log: Logged[] = [];
    const transport = new FakeTransport(true);
    transport.checkpointValue = {};
    const next = managerIn(
      dir,
      transport,
      ({ event }) => log.push(event.type),
      loggedGeneration(dir, log),
    );
    await next.loadCatalog();
    await next.attach(sessionId, ACTOR, "controller");
    await next.submitExec(sessionId, ACTOR, "1");
    await Bun.sleep(0);
    expect(log).toContain("session/recoveryStarted");
    expect(log).toContain("session/recoveryFinished");
    expect(
      eachSyncedBefore(
        log,
        new Set(["session/recoveryStarted", "session/recoveryFinished"]),
      ),
    ).toEqual([]);
    await next.shutdown();
  });
});

/**
 * A transport whose interrupts recycle the host, which leaves a module the
 * server removes.
 */
class RecyclingTransport extends FakeTransport {
  override async interrupt(): Promise<"soft" | "recycle"> {
    return "recycle";
  }
  endedHostFiles(scratchDir: string, handle: TransportSessionHandle): string[] {
    return [join(scratchDir, "go", `${handle.sessionId}-module`)];
  }
}

test("a recycled host's module is removed only once the recycle's bump is on the disk", async () => {
  await withTempDir(async (dir) => {
    const log: string[] = [];
    let module = "";
    const transport = new RecyclingTransport(false);
    const manager = managerIn(
      dir,
      transport,
      ({ event }) => log.push(event.type),
      new StateGeneration(dir, {
        file: () =>
          log.push(
            module && existsSync(module) ? "sync, the module there" : "sync",
          ),
        directory: () => undefined,
      }),
    );
    await manager.loadCatalog();
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "recycled",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    module = join(dir, "scratch", sessionId, "go", `${sessionId}-module`);
    mkdirSync(join(module, "plugins"), { recursive: true });
    writeFileSync(join(module, "plugins", "c0001.so"), "mapped by the host");
    await manager.submitExec(sessionId, ACTOR, "for (;;) {}");
    log.length = 0;
    await manager.interrupt(sessionId, ACTOR);
    expect(existsSync(module)).toBe(false);
    const recycled = log.indexOf("session/runtimeRecycled");
    expect(recycled).toBeGreaterThan(0);
    expect(log.slice(0, recycled)).toContain("sync, the module there");
  });
});

/** A generation whose syncs fail with EIO once `failing()` says so. */
function failingGeneration(
  dir: string,
  failing: () => boolean,
): StateGeneration {
  return new StateGeneration(dir, {
    file: () => {
      if (failing())
        throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    },
    directory: () => undefined,
  });
}

test("an exec whose end cannot move the generation on quarantines its session, untold, and ends for whoever waits on it", async () => {
  await withTempDir(async (dir) => {
    let failing = false;
    const told: string[] = [];
    const transport = new FakeTransport(false);
    const manager = managerIn(
      dir,
      transport,
      ({ event }) => told.push(event.type),
      failingGeneration(dir, () => failing),
    );
    await manager.loadCatalog();
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "eio",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    const { execId } = await manager.submitExec(sessionId, ACTOR, "1");
    told.length = 0;
    failing = true;
    transport.completeNext(sessionId);
    await Bun.sleep(10);
    expect(manager.detail(sessionId).status).toBe("quarantined");
    expect(manager.exec(sessionId, execId).status).not.toBe("running");
    expect(told).not.toContain("exec/finished");
    expect(told).not.toContain("session/quarantined");
  });
});

test("an interrupt whose exec's end cannot move the generation on quarantines its session, and ends the exec for whoever waits on it", async () => {
  await withTempDir(async (dir) => {
    let failing = false;
    const told: string[] = [];
    const transport = new FakeTransport(false);
    const manager = managerIn(
      dir,
      transport,
      ({ event }) => told.push(event.type),
      failingGeneration(dir, () => failing),
    );
    await manager.loadCatalog();
    const { sessionId } = await manager.createWithPolicy(
      ACTOR,
      "eio",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    const { execId } = await manager.submitExec(
      sessionId,
      ACTOR,
      "for (;;) {}",
    );
    told.length = 0;
    failing = true;
    await expect(manager.interrupt(sessionId, ACTOR)).rejects.toThrow(
      StateGenerationNotMoved,
    );
    expect(manager.detail(sessionId).status).toBe("quarantined");
    expect(manager.exec(sessionId, execId).status).toBe("interrupted");
    // Its files go, as the exec ends for whoever waits on it.
    expect(
      existsSync(
        dirname(execFilePath(join(dir, "execs"), sessionId, execId, "exec")),
      ),
    ).toBe(false);
    // Neither its end nor its session's quarantine is told.
    expect(told).not.toContain("exec/finished");
    expect(told).not.toContain("session/quarantined");
  });
});

test("what a save caught is on the disk, the file and its directory synced", async () => {
  await withTempDir(async (dir) => {
    const synced: string[] = [];
    writeLastSave(
      dir,
      { generation: 4, running: [] },
      {
        file: () => synced.push("file"),
        directory: () => synced.push("directory"),
      },
    );
    expect(synced).toEqual(["file", "directory"]);
    expect(JSON.parse(readFileSync(join(dir, LAST_SAVE_FILE), "utf8"))).toEqual(
      {
        schemaVersion: 1,
        generation: 4,
        running: [],
      },
    );
  });
});

test("a fresh start bears a session's scratch that is no directory, and says where /proc hides processes", async () => {
  await withTempDir(async (dir) => {
    const before = managerIn(dir, new FakeTransport(true), () => undefined);
    await before.loadCatalog();
    const { sessionId } = await before.createWithPolicy(
      ACTOR,
      "odd",
      dir,
      { durabilityMode: "checkpointed", initialCheckpoint: {} },
      "controller",
    );
    await before.shutdown();
    const scratch = join(dir, "scratch", sessionId);
    rmSync(scratch, { recursive: true, force: true });
    writeFileSync(scratch, "no directory");
    const manager = managerIn(dir, new FakeTransport(true), () => undefined);
    await manager.loadCatalog();
    expect(readFileSync(scratch, "utf8")).toBe("no directory");
    await manager.shutdown();
  });
  expect(
    procHidepid(
      "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible 0 0\n",
    ),
  ).toBe("invisible");
  expect(
    procHidepid(
      "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=2 0 0\n",
    ),
  ).toBe("2");
  expect(
    procHidepid("proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n"),
  ).toBeNull();
  expect(
    procHidepid("proc /proc proc rw,hidepid=0 0 0\nsysfs /sys sysfs rw 0 0\n"),
  ).toBeNull();
});

/** A PNG of one pixel, as a cell shows one. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** Every directory and file under `root`, and what each file holds. */
function treeOf(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  for (const entry of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    const path = join(entry.parentPath, entry.name);
    tree[relative(root, path)] = entry.isDirectory()
      ? "directory"
      : readFileSync(path).toString("base64");
  }
  return tree;
}

test("a server restored from a save its state directory moved on from writes nothing there: not what its caught execs leave, a save, nor its stop", async () => {
  await withTempDir(async (outside) => {
    await withTempDir(async (dir) => {
      const transport = new SnapshottingTransport(false);
      const manager = new SessionManager(
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
      await manager.loadCatalog();
      // One session's exec ends with its checkpoint; another's shows an image;
      // a third, idle, would be dumped as the server stops.
      await manager.createWithPolicy(
        ACTOR,
        "idle",
        dir,
        { durabilityMode: "checkpointed", initialCheckpoint: {} },
        "controller",
      );
      const checkpointed = await manager.createWithPolicy(
        ACTOR,
        "checkpointed",
        dir,
        { durabilityMode: "checkpointed", initialCheckpoint: {} },
        "controller",
      );
      const showing = await manager.createWithPolicy(
        ACTOR,
        "showing",
        dir,
        { durabilityMode: "checkpointed", initialCheckpoint: {} },
        "controller",
      );
      await manager.submitExec(checkpointed.sessionId, ACTOR, "1");
      await manager.submitExec(showing.sessionId, ACTOR, "2");
      markSandboxSaved();
      manager.sandboxSaving();
      // The sandbox saved live ran on, its execs ended there, and it moved the
      // generation on: what it wrote is newer than anything this one has.
      const ranOn = new StateGeneration(dir);
      ranOn.bump();
      ranOn.close();
      const before = treeOf(dir);

      // Restored from the save, its caught execs end before its hook arrives.
      transport.checkpointValue = { stale: true };
      transport.completeNext(checkpointed.sessionId);
      const image = join(outside, "shown.png");
      writeFileSync(image, PNG);
      transport.emit(
        showing.sessionId,
        `${transport.pendingEventPrefix(showing.sessionId)}${JSON.stringify({
          kind: "image",
          payloadPath: image,
        })}\n`,
      );
      await Bun.sleep(10);
      expect(() => manager.sandboxSaving()).toThrow(StateGenerationNotMoved);
      await manager.shutdown().catch(() => undefined);
      expect(treeOf(dir)).toEqual(before);
    });
  });
});

test("a server whose generation is stale starts no session's host, and a fresh start that cannot move it on removes nothing", async () => {
  await withTempDir(async (dir) => {
    const manager = managerIn(dir, new FakeTransport(false), () => undefined);
    await manager.loadCatalog();
    const ranOn = new StateGeneration(dir);
    ranOn.bump();
    ranOn.close();
    const stale = treeOf(dir);
    // Its host would write in its scratch directory.
    await expect(
      manager.createWithPolicy(
        ACTOR,
        "unstarted",
        dir,
        { durabilityMode: "ephemeral" },
        "controller",
      ),
    ).rejects.toThrow("the state generation is stale");
    // Nor writes the first checkpoint of one.
    await expect(
      manager.createWithPolicy(
        ACTOR,
        "uncheckpointed",
        dir,
        { durabilityMode: "checkpointed", initialCheckpoint: {} },
        "controller",
      ),
    ).rejects.toThrow("the state generation is stale");
    expect(treeOf(dir)).toEqual(stale);
  });
  await withTempDir(async (dir) => {
    // What no session of the catalog owns, which a start sweeps away, beside
    // the generation the server before left.
    mkdirSync(join(dir, "scratch", "sess_orphan"), { recursive: true });
    const left = new StateGeneration(dir);
    left.bump();
    left.close();
    const manager = managerIn(
      dir,
      new FakeTransport(false),
      () => undefined,
      failingGeneration(dir, () => true),
    );
    // But the generation's own file, whose write the failed sync leaves.
    const withoutGeneration = () => {
      const { [STATE_GENERATION_FILE]: _generation, ...rest } = treeOf(dir);
      return rest;
    };
    const before = withoutGeneration();
    await expect(manager.loadCatalog()).rejects.toThrow(
      StateGenerationNotMoved,
    );
    expect(withoutGeneration()).toEqual(before);
  });
});
