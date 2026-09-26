import { expect, test } from "bun:test";
import { readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  aggregateFailure,
  CriuSnapshotter,
  describeFailure,
  ProcessTransport,
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
    advancePidsPast: () => undefined,
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

    expect(dumped).toEqual([
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
