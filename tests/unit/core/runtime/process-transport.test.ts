import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  aggregateFailure,
  CriuSnapshotter,
  describeFailure,
  ProcessTransport,
  SESSION_PID_FLOOR,
  type ProcessSnapshotter,
} from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!processExists(pid)) return;
    await sleep(25);
  }
}

test("aggregate lifecycle errors expose every nested cause", () => {
  const leaf = new Error("leaf failure");
  const inner = aggregateFailure("inner cleanup failed", [leaf]);
  const outer = aggregateFailure("outer cleanup failed", [
    inner,
    new TypeError("second failure"),
  ]);

  expect(outer.message).toBe(
    "outer cleanup failed: inner cleanup failed: Error: leaf failure; TypeError: second failure",
  );
  expect(outer.errors).toEqual([inner, expect.any(TypeError)]);

  const cyclic = new AggregateError([], "cyclic cleanup failed");
  cyclic.errors.push(cyclic);
  expect(describeFailure(cyclic)).toBe(
    "cyclic cleanup failed: AggregateError: circular aggregate cause",
  );
  expect(aggregateFailure("empty cleanup failed", []).message).toBe(
    "empty cleanup failed",
  );
});

test("process transport escalates termination when a child ignores SIGTERM", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.on("SIGTERM", () => {}); process.stdout.write("READY> "); setInterval(() => {}, 1_000)',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_terminate",
    title: "terminate",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  await transport.waitForInitialPrompt(handle);

  await transport.terminate(handle);

  expect(() => process.kill(handle.pid, 0)).toThrow();
  expect(() => transport.promptCount(handle)).toThrow(
    "unknown or stale transport session sess_terminate",
  );
});

test("process transport can submit Enter after piped line bytes", async () => {
  let output = "";
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    // Wide enough that the child reads the line before its Enter arrives,
    // however busy the machine: what is under test is that they arrive apart.
    lineSubmitDelayMs: 200,
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write("READY> ");',
          "let commandSeen = false;",
          'process.stdin.on("data", (chunk) => {',
          '  const text = chunk.toString("utf8");',
          '  if (text === "COMMAND") { commandSeen = true; return; }',
          '  if (text === "\\n" && commandSeen) { process.stdout.write("SPLIT\\n"); return; }',
          '  process.stdout.write("JOINED:" + JSON.stringify(text) + "\\n");',
          "});",
        ].join(" "),
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_split_line",
    title: "split line",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  await transport.subscribe(handle, (chunk) => {
    output += Buffer.from(chunk).toString("utf8");
  });
  try {
    await transport.waitForInitialPrompt(handle);
    await transport.write(handle, "COMMAND\n");
    for (
      let attempt = 0;
      attempt < 200 && !output.includes("SPLIT");
      attempt += 1
    ) {
      await sleep(5);
    }
    expect(output).toContain("SPLIT");
    expect(output).not.toContain("JOINED:");
  } finally {
    await transport.terminate(handle);
  }
});

test("process transport rejects invalid line-submit delays", () => {
  expect(
    () =>
      new ProcessTransport({
        platformId: "test",
        promptRe: /READY>/g,
        lineSubmitDelayMs: -1,
        command: () => ({ file: process.execPath, args: [] }),
      }),
  ).toThrow("line submit delay must be a non-negative integer");
});

test("termination ends the session's whole process group, descendants that ignore SIGTERM included", async () => {
  let output = "";
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        [
          'const { spawn } = require("node:child_process");',
          `const child = spawn(${JSON.stringify(process.execPath)}, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
          'setTimeout(() => process.stdout.write("CHILD=" + child.pid + "\\nREADY> "), 50);',
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_process_group",
    title: "process group",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  await transport.subscribe(handle, (chunk) => {
    output += Buffer.from(chunk).toString("utf8");
  });
  await transport.waitForInitialPrompt(handle);
  const descendantPid = Number(output.match(/CHILD=(\d+)/)?.[1]);
  expect(descendantPid).toBeGreaterThan(0);
  expect(processExists(descendantPid)).toBe(true);

  await transport.terminate(handle);
  await waitForProcessExit(descendantPid);

  expect(processExists(handle.pid)).toBe(false);
  expect(processExists(descendantPid)).toBe(false);
});

test("a runtime's temporary directory is its session's scratch directory", async () => {
  await withTempDir(async (scratchDir) => {
    let output = "";
    const transport = new ProcessTransport({
      platformId: "test",
      promptRe: /(?:^|[\r\n])READY> /g,
      command: () => ({
        file: process.execPath,
        args: [
          "-e",
          'process.stdout.write("TMPDIR=" + require("node:os").tmpdir() + "\\nREADY> "); setInterval(() => {}, 1_000)',
        ],
      }),
    });
    const handle = await transport.startSession({
      sessionId: "sess_scratch_tmpdir",
      title: "scratch tmpdir",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      scratchDir,
    });
    await transport.subscribe(handle, (chunk) => {
      output += Buffer.from(chunk).toString("utf8");
    });
    try {
      await transport.waitForInitialPrompt(handle);
      expect(output).toContain(`TMPDIR=${scratchDir}\n`);
    } finally {
      await transport.terminate(handle);
    }
  });
});

test("a transport offers process snapshots only where it has a snapshotter", () => {
  const config = {
    platformId: "test",
    promptRe: /READY>/g,
    command: () => ({ file: process.execPath, args: [] }),
  };
  const snapshotter = new CriuSnapshotter("/opt/criu", "/opt/advance-pids");

  expect(
    new ProcessTransport({ ...config, snapshotter }).snapshots,
  ).toBeDefined();
  expect(
    new ProcessTransport({ ...config, snapshotter: null }).snapshots,
  ).toBeUndefined();
  expect(
    new ProcessTransport({ ...config, snapshots: false, snapshotter })
      .snapshots,
  ).toBeUndefined();
});

/**
 * A snapshotter that notes, in `steps`, the dumps it is asked for, which end
 * their tree, the PIDs it is asked past, and each check of the counter. Its
 * dumps fail as CRIU's do where it cannot run if `unavailable` is given; its
 * advances fail with `failure`, and end once `advanced` does; its checks
 * find the counter past the PID as `past` says, in turn, and then always.
 */
function pidAdvancingSnapshotter(
  steps: string[],
  {
    unavailable,
    failure,
    advanced,
    past = [],
  }: {
    unavailable?: string;
    failure?: string;
    advanced?: Promise<void>;
    past?: boolean[];
  } = {},
): ProcessSnapshotter {
  return {
    dump(pid, _directory, stdio) {
      steps.push("dump");
      if (unavailable) throw new Error(unavailable);
      process.kill(pid, "SIGKILL");
      return {
        pid,
        maxPid: pid,
        stdio,
        stdioFds: [0, 1, 2],
        bootId: "boot",
        baymaVersion: "0.0.0",
        createdAtMs: 0,
      };
    },
    restoreCommand: () => ({ file: "/bin/false", args: [] }),
    restoredPid: () => undefined,
    unrestorableReason: () => undefined,
    pidCounter: () => undefined,
    pidsPast(pid) {
      steps.push(`check ${pid}`);
      return past.shift() ?? true;
    },
    async advancePidsPast(pid) {
      steps.push(`past ${pid}`);
      await advanced;
      if (failure) throw new Error(failure);
    },
  };
}

/** A transport whose runtime, a shell, prompts once; it notes its steps. */
function promptingTransport(
  steps: string[],
  snapshotter: ProcessSnapshotter,
): ProcessTransport {
  return new ProcessTransport({
    platformId: "test",
    promptRe: /READY> /g,
    prepare: async () => {
      steps.push("prepare");
    },
    command: () => {
      steps.push("start");
      return { file: "/bin/sh", args: ["-c", 'printf "READY> "; sleep 30'] };
    },
    snapshotter,
  });
}

/** Start each of `sessionIds` in `transport`, one after another. */
async function startEach(
  transport: ProcessTransport,
  sessionIds: string[],
): Promise<void> {
  for (const sessionId of sessionIds)
    await transport.waitForInitialPrompt(
      await transport.startSession({
        sessionId,
        title: sessionId,
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        scratchDir: tmpdir(),
      }),
    );
}

const floor = SESSION_PID_FLOOR;

test("every runtime starts once the PID counter is past the floor, checked after what prepares it, where snapshots can be taken", async () => {
  const steps: string[] = [];
  const transport = promptingTransport(steps, pidAdvancingSnapshotter(steps));
  try {
    await startEach(transport, ["sess_floor_first", "sess_floor_second"]);

    // Whether snapshots can be taken here is found by a dump, once.
    expect(steps).toEqual([
      "prepare",
      "dump",
      `past ${floor}`,
      `check ${floor}`,
      "start",
      "prepare",
      `past ${floor}`,
      `check ${floor}`,
      "start",
    ]);
  } finally {
    await transport.shutdown();
  }
});

test("a PID counter found below the floor as a runtime is about to start is moved past it again first", async () => {
  const steps: string[] = [];
  const transport = promptingTransport(
    steps,
    pidAdvancingSnapshotter(steps, { past: [false] }),
  );
  try {
    await startEach(transport, ["sess_wrapped"]);

    expect(steps).toEqual([
      "prepare",
      "dump",
      `past ${floor}`,
      `check ${floor}`,
      `past ${floor}`,
      `check ${floor}`,
      "start",
    ]);
  } finally {
    await transport.shutdown();
  }
});

test("runtimes starting together wait on one advance past the floor, the event loop running on meanwhile", async () => {
  const steps: string[] = [];
  let advance!: () => void;
  const advanced = new Promise<void>((resolve) => (advance = resolve));
  const snapshotter = pidAdvancingSnapshotter(steps, { advanced });
  const transports = [
    promptingTransport(steps, snapshotter),
    promptingTransport(steps, snapshotter),
  ];
  try {
    const started = Promise.all([
      startEach(transports[0]!, ["sess_together_first"]),
      startEach(transports[1]!, ["sess_together_second"]),
    ]);
    while (!steps.includes(`past ${floor}`)) await sleep(5);
    // A timer fires while the advance is under way, and no runtime starts.
    await sleep(20);
    expect(steps.filter((step) => step === "start")).toEqual([]);
    advance();
    await started;

    expect(steps.filter((step) => step === `past ${floor}`)).toHaveLength(1);
    expect(steps.filter((step) => step === "start")).toHaveLength(2);
  } finally {
    await Promise.all(transports.map((transport) => transport.shutdown()));
  }
});

test("where no snapshot can be taken, runtimes start wherever the PID counter is", async () => {
  const steps: string[] = [];
  const transport = promptingTransport(
    steps,
    pidAdvancingSnapshotter(steps, { unavailable: "CRIU could not start" }),
  );
  try {
    await startEach(transport, [
      "sess_unfloored_first",
      "sess_unfloored_second",
    ]);

    expect(steps).toEqual(["prepare", "dump", "start", "prepare", "start"]);
  } finally {
    await transport.shutdown();
  }
});

test("runtimes the PID counter cannot be moved past the floor for start all the same, said once", async () => {
  const reports: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    reports.push(String(chunk));
    return true;
  });
  const steps: string[] = [];
  const failure =
    "advancing PIDs past 10000 failed: bayma-advance-pids: PID 10001 is not below this namespace's pid_max, 8192";
  const transport = promptingTransport(
    steps,
    pidAdvancingSnapshotter(steps, { failure }),
  );
  try {
    await startEach(transport, ["sess_below_first", "sess_below_second"]);

    expect(steps).toEqual([
      "prepare",
      "dump",
      `past ${floor}`,
      "start",
      "prepare",
      `past ${floor}`,
      "start",
    ]);
    expect(reports).toEqual([
      `bayma: sessions' runtimes may start below PID ${floor}: ${failure}\n`,
    ]);
  } finally {
    stderr.mockRestore();
    await transport.shutdown();
  }
});

test("a snapshot hands the dump the stdio its runtime started with, wherever the runtime moved them", async () => {
  const dumped: { pid: number; stdio: string[] }[] = [];
  const snapshotter: ProcessSnapshotter = {
    dump(pid, _directory, stdio) {
      dumped.push({ pid, stdio });
      // A dump ends its tree.
      process.kill(-pid, "SIGKILL");
      return {
        pid,
        maxPid: pid,
        stdio,
        stdioFds: [0, 4, 2],
        bootId: "boot",
        baymaVersion: "0.0.0",
        createdAtMs: 0,
      };
    },
    restoreCommand: () => ({ file: "/bin/false", args: [] }),
    restoredPid: () => undefined,
    unrestorableReason: () => undefined,
    pidsPast: () => true,
    pidCounter: () => undefined,
    advancePidsPast: async () => undefined,
  };
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /READY> /g,
    // As the Go host does: the protocol moves off stdout, which then goes
    // elsewhere.
    command: () => ({
      file: "/bin/sh",
      args: ["-c", 'exec 4>&1 1>/dev/null; printf "READY> " >&4; sleep 30'],
    }),
    snapshotter,
  });
  const handle = await transport.startSession({
    sessionId: "sess_moved_stdio",
    title: "moved stdio",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  try {
    await transport.waitForInitialPrompt(handle);
    expect(readlinkSync(`/proc/${handle.pid}/fd/1`)).toBe("/dev/null");
    const stdout = readlinkSync(`/proc/${handle.pid}/fd/4`);

    const snapshot = await transport.snapshots!.snapshot(handle, tmpdir());

    // After the dump that found snapshots can be taken here.
    expect(dumped).toEqual([
      expect.anything(),
      {
        pid: handle.pid,
        stdio: [expect.any(String), stdout, expect.any(String)],
      },
    ]);
    for (const link of snapshot.stdio) expect(link).toMatch(/^socket:\[\d+\]$/);
  } finally {
    await transport.shutdown();
  }
});

test("a restore that fails says how CRIU ended, what it printed, and its log's errors", async () => {
  await withTempDir(async (dir) => {
    const restore = async (criu: string) => {
      const transport = new ProcessTransport({
        platformId: "test",
        promptRe: /READY> /g,
        command: () => ({ file: "/bin/false", args: [] }),
        snapshotter: {
          dump: () => {
            throw new Error("this transport only restores");
          },
          restoreCommand: () => ({ file: criu, args: [] }),
          restoredPid: () => undefined,
          unrestorableReason: () => undefined,
          pidsPast: () => true,
          pidCounter: () => undefined,
          advancePidsPast: async () => undefined,
        },
      });
      try {
        await transport.snapshots!.restore(
          {
            sessionId: "sess_unrestored",
            title: "unrestored",
            cwd: process.cwd(),
            cols: 80,
            rows: 24,
            scratchDir: tmpdir(),
          },
          {
            pid: 4_100,
            maxPid: 4_100,
            stdio: ["pipe:[1]", "pipe:[2]", "pipe:[3]"],
            stdioFds: [0, 1, 2],
            bootId: "boot",
            baymaVersion: "0.0.0",
            createdAtMs: 0,
          },
          dir,
        );
      } finally {
        await transport.shutdown();
      }
    };
    const script = (name: string, body: string) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const notExecutable = join(dir, "not-executable");
    writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n");

    await expect(restore(join(dir, "missing"))).rejects.toThrow(
      /^restoring session sess_unrestored failed:\nCRIU could not start: .*ENOENT/,
    );
    await expect(restore(notExecutable)).rejects.toThrow(
      /^restoring session sess_unrestored failed:\nCRIU could not start: .*EACCES/,
    );
    await expect(restore(script("killed", "kill -KILL $$"))).rejects.toThrow(
      "restoring session sess_unrestored failed:\nCRIU was killed by SIGKILL",
    );
    await expect(
      restore(
        script(
          "refused",
          [
            "echo 'Warn (criu/kerndat.c:1): no kerndat cache' >&2",
            `echo '(00.1) Error (criu/cr-restore.c:1): PID 4100 is taken' > ${JSON.stringify(join(dir, "restore.log"))}`,
            "exit 1",
          ].join("\n"),
        ),
      ),
    ).rejects.toThrow(
      "restoring session sess_unrestored failed:\nCRIU exited with status 1\nWarn (criu/kerndat.c:1): no kerndat cache\n(00.1) Error (criu/cr-restore.c:1): PID 4100 is taken",
    );
  });
});

test("stale transport handles cannot affect a replacement child", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); setInterval(() => {}, 1_000)',
      ],
    }),
  });
  const input = {
    sessionId: "sess_recycled",
    title: "recycled",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  };
  const staleHandle = await transport.startSession(input);
  await transport.waitForInitialPrompt(staleHandle);
  await expect(transport.startSession(input)).rejects.toThrow(
    "transport session sess_recycled already exists",
  );
  await transport.terminate(staleHandle);

  const replacementHandle = await transport.startSession(input);
  try {
    await transport.waitForInitialPrompt(replacementHandle);
    await transport.terminate(staleHandle);

    expect(() => process.kill(replacementHandle.pid, 0)).not.toThrow();
    expect(() => transport.promptCount(staleHandle)).toThrow(
      "unknown or stale transport session sess_recycled",
    );
    expect(transport.promptCount(replacementHandle)).toBeGreaterThan(0);
  } finally {
    await transport.terminate(replacementHandle);
  }
});

test("prompt-like output cannot fake post-interrupt readiness", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    interruptStrategy: "write_ctrl_c",
    interruptProbe: (nonce) => ({
      input: `PROBE ${nonce}\n`,
      expectedOutput: `ACK ${nonce}`,
    }),
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); process.stdin.on("data", (chunk) => { if (chunk.includes(3)) process.stdout.write("\\nREADY> "); });',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_fake_interrupt_prompt",
    title: "fake interrupt prompt",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  try {
    await transport.waitForInitialPrompt(handle);
    expect(await transport.interrupt(handle, 50)).toBe("recycle");
  } finally {
    await transport.terminate(handle);
  }
});

test("single-character probe overlap stays bounded", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    interruptStrategy: "write_ctrl_c",
    interruptProbe: () => ({ input: "PROBE\n", expectedOutput: "Q" }),
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); process.stdin.on("data", (chunk) => { if (chunk.includes(3)) { process.stdout.write("\\nREADY> "); return; } process.stdout.write("x".repeat(1024 * 1024)); });',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_single_character_probe",
    title: "single character probe",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  let observedBytes = 0;
  await transport.subscribe(handle, (chunk) => {
    observedBytes += chunk.byteLength;
  });
  try {
    await transport.waitForInitialPrompt(handle);
    observedBytes = 0;
    const interrupt = transport.interrupt(handle, 500);
    for (
      let attempt = 0;
      attempt < 100 && observedBytes < 512 * 1024;
      attempt += 1
    ) {
      await sleep(5);
    }
    const state = (
      transport as unknown as {
        sessions: Map<string, { readinessWaiters: Set<{ scanTail: string }> }>;
      }
    ).sessions.get(handle.sessionId)!;

    expect(observedBytes).toBeGreaterThanOrEqual(512 * 1024);
    expect([...state.readinessWaiters][0]?.scanTail).toBe("");
    expect(await interrupt).toBe("recycle");
  } finally {
    await transport.terminate(handle);
  }
});

test("a process exit caused by interrupt is delegated to recycle ownership", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    interruptStrategy: "sigint",
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); setInterval(() => {}, 1_000)',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_interrupt_exit",
    title: "interrupt exit",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  let unsolicitedExitCount = 0;
  await transport.subscribe(
    handle,
    () => undefined,
    () => {
      unsolicitedExitCount += 1;
    },
  );
  await transport.waitForInitialPrompt(handle);

  expect(await transport.interrupt(handle)).toBe("recycle");
  expect(unsolicitedExitCount).toBe(0);
  await transport.terminate(handle);
});

test("recycle-only interruption leaves teardown to session ownership", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    interruptStrategy: "recycle",
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); setInterval(() => {}, 1_000)',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_recycle_only",
    title: "recycle-only",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  await transport.waitForInitialPrompt(handle);

  expect(await transport.interrupt(handle)).toBe("recycle");
  expect(processExists(handle.pid)).toBe(true);
  await transport.terminate(handle);
  expect(processExists(handle.pid)).toBe(false);
});

test("a process that exits after its interrupt probe cannot report soft recovery", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    interruptStrategy: "write_ctrl_c",
    interruptProbe: (nonce) => ({
      input: `PROBE ${nonce}\n`,
      expectedOutput: `ACK ${nonce}`,
    }),
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); process.stdin.on("data", (chunk) => { const text = chunk.toString(); if (chunk.includes(3)) { process.stdout.write("\\nREADY> "); return; } if (text.startsWith("PROBE ")) { process.stdout.write("\\nREADY> \\nACK " + text.slice(6).trim()); process.exit(0); } });',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_probe_then_exit",
    title: "probe then exit",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  await transport.waitForInitialPrompt(handle);

  expect(await transport.interrupt(handle)).toBe("recycle");
  await transport.terminate(handle);
});

test("interrupt recovery requires a post-probe runtime prompt", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    interruptStrategy: "write_ctrl_c",
    interruptProbe: (nonce) => ({
      input: `PROBE ${nonce}\n`,
      expectedOutput: `ACK ${nonce}`,
    }),
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); process.stdin.on("data", (chunk) => { const text = chunk.toString(); if (chunk.includes(3)) { process.stdout.write("\\nREADY> "); return; } if (text.startsWith("PROBE ")) { process.stdout.write("ACK " + text.slice(6).trim() + "\\nREADY> "); } });',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_probe_then_prompt",
    title: "probe then prompt",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  try {
    await transport.waitForInitialPrompt(handle);

    expect(await transport.interrupt(handle)).toBe("soft");
    expect(processExists(handle.pid)).toBe(true);
  } finally {
    await transport.terminate(handle);
  }
});

test("interrupt exit rejects internal backpressure without notifying observers", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    interruptStrategy: "sigint",
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        'process.stdout.write("READY> "); setInterval(() => {}, 1_000)',
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_interrupt_backpressure",
    title: "interrupt backpressure",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  let unsolicitedExitCount = 0;
  await transport.subscribe(
    handle,
    () => undefined,
    () => {
      unsolicitedExitCount += 1;
    },
  );
  await transport.waitForInitialPrompt(handle);

  const state = (
    transport as unknown as {
      sessions: Map<
        string,
        { child: { stdin: { write: (chunk: Uint8Array) => boolean } } }
      >;
    }
  ).sessions.get(handle.sessionId)!;
  state.child.stdin.write = () => false;
  const writeOutcome = transport
    .write(handle, Buffer.from("forced backpressure"))
    .then(
      () => "resolved" as const,
      (error: unknown) => error,
    );
  const interrupt = transport.interrupt(handle);
  const outcome = await Promise.race([
    writeOutcome,
    sleep(2_000).then(() => "timed-out" as const),
  ]);

  expect(outcome).toBeInstanceOf(Error);
  expect(await interrupt).toBe("recycle");
  expect(unsolicitedExitCount).toBe(0);
  await transport.terminate(handle);
});

test("exit diagnostics preserve UTF-8 split across stdout chunks", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])READY> /g,
    command: () => ({
      file: process.execPath,
      args: [
        "-e",
        "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => { process.stdout.write(Buffer.from([0x82, 0xac])); process.exit(7); }, 10)",
      ],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_utf8_diagnostic",
    title: "utf8 diagnostic",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });

  await expect(transport.waitForInitialPrompt(handle, 2_000)).rejects.toThrow(
    "€",
  );
  await transport.terminate(handle);
});

test("a runtime the kernel kills for its memory, as the server's cgroup counts a kill since it started, says so, with the cgroup's limit where it has one; one killed otherwise, or under a cgroup it cannot read, as it was", async () => {
  await withTempDir(async (root) => {
    // Cgroups of the test's own, limited and not, each counting two kills.
    const limited = join(root, "limited");
    const unlimited = join(root, "unlimited");
    for (const [dir, max] of [
      [limited, String(1536 * 2 ** 20)],
      [unlimited, "max"],
    ] as const) {
      mkdirSync(dir);
      writeFileSync(join(dir, "memory.events"), "oom 0\noom_kill 2\n");
      writeFileSync(join(dir, "memory.max"), `${max}\n`);
    }
    // A runtime that counts its cgroup's kills at `kills`, then is killed.
    const killed = async (
      sessionId: string,
      cgroupDir: string,
      kills: number,
    ) => {
      const transport = new ProcessTransport({
        platformId: "test",
        promptRe: /(?:^|[\r\n])READY> /g,
        startupTimeoutMs: 2_000,
        command: () => ({
          file: "/bin/sh",
          args: [
            "-c",
            `printf 'oom 1\\noom_kill ${kills}\\n' > '${join(cgroupDir, "memory.events")}' 2>/dev/null; kill -9 $$`,
          ],
        }),
        snapshots: false,
        cgroupDir,
      });
      const handle = await transport.startSession({
        sessionId,
        title: "killed",
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        scratchDir: tmpdir(),
      });
      try {
        return await transport.waitForInitialPrompt(handle).then(
          () => "it prompted",
          // Its name too, as the session manager tells a kill for memory by it.
          (error: unknown) =>
            `${(error as Error).name}: ${(error as Error).message}`,
        );
      } finally {
        await transport.shutdown();
      }
    };
    expect(await killed("sess_oom", limited, 3)).toContain(
      "RuntimeMemoryKilled: transport session sess_oom ran out of its memory (1536Mi) and was killed by the kernel (code=null, signal=SIGKILL)",
    );
    // No kill counted since it started.
    expect(await killed("sess_killed", limited, 3)).toContain(
      "Error: transport session sess_killed exited unexpectedly (code=null, signal=SIGKILL)",
    );
    expect(await killed("sess_free", unlimited, 3)).toContain(
      "RuntimeMemoryKilled: transport session sess_free ran out of memory and was killed by the kernel",
    );
    // Under cgroup v1, or none: nothing said of memory.
    expect(await killed("sess_unread", join(root, "none"), 3)).toContain(
      "transport session sess_unread exited unexpectedly (code=null, signal=SIGKILL)",
    );
  });
});

test("a runtime the server kills itself, as its termination kills one that holds out against SIGTERM, is never taken for one killed for its memory, however the cgroup counted", async () => {
  await withTempDir(async (dir) => {
    const events = join(dir, "memory.events");
    writeFileSync(events, "oom 0\noom_kill 2\n");
    writeFileSync(join(dir, "memory.max"), `${1536 * 2 ** 20}\n`);
    const transport = new ProcessTransport({
      platformId: "test",
      promptRe: /(?:^|[\r\n])READY> /g,
      startupTimeoutMs: 2_000,
      command: () => ({
        file: "/bin/sh",
        // Another process of the cgroup killed for its memory meanwhile.
        args: [
          "-c",
          `trap '' TERM; printf 'oom 1\\noom_kill 3\\n' > '${events}'; printf 'READY> '; while :; do sleep 1; done`,
        ],
      }),
      snapshots: false,
      cgroupDir: dir,
    });
    const handle = await transport.startSession({
      sessionId: "sess_terminated",
      title: "terminated",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      scratchDir: tmpdir(),
    });
    try {
      await transport.waitForInitialPrompt(handle);
      const ended = new Promise<string>((resolve) => {
        void transport.subscribe(
          handle,
          () => undefined,
          (error) => resolve(error.message),
        );
      });
      await transport.terminate(handle);
      expect(await ended).toContain(
        "transport session sess_terminated exited unexpectedly (code=null, signal=SIGKILL)",
      );
    } finally {
      await transport.shutdown();
    }
  });
});
