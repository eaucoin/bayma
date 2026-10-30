import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, readlinkSync } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { aggregateFailure, failureMessage } from "../errors.ts";
import {
  KILL_FIRST_FOR_MEMORY,
  killedFirstForMemory,
  ranOutOf,
  RuntimeMemoryKilled,
  watchMemoryKills,
} from "./memory-kills.ts";
import { runningTimeout, type RunningTimeout } from "../sandbox.ts";
import { report } from "../telemetry/record.ts";
import {
  criuEnding,
  processSnapshotter,
  restoreFailure,
  SESSION_PID_FLOOR,
  snapshotsUnavailableHere,
  type CriuExit,
  type ProcessSnapshot,
  type ProcessSnapshotter,
} from "./process-snapshots.ts";
import type {
  RuntimeTransport,
  StartSessionInput,
  TransportChunkListener,
  TransportExitListener,
  TransportSessionHandle,
  TransportSnapshots,
} from "./transport.ts";

interface PromptWaiter {
  seenPromptCount: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: RunningTimeout;
}

interface ReadinessWaiter {
  expectedText: string;
  scanTail: string;
  acknowledged: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: RunningTimeout;
}

interface BrokerState {
  handle: TransportSessionHandle;
  /**
   * The process this transport started: the runtime, or for a restored
   * session CRIU, which waits on the restored runtime and exits as it does.
   * Either way its stdio are the runtime's.
   */
  child: ChildProcessWithoutNullStreams;
  /** The runtime, which leads its own process group: what signals reach. */
  pid: number;
  /**
   * The stdio the runtime started with, as the kernel names them, such as
   * `socket:[1234]`: what a snapshot of it hands new stdio in place of,
   * wherever it has moved them since. Absent where snapshots are off, or they
   * could not be read.
   */
  stdio?: [string, string, string];
  /**
   * For a restored runtime, where it holds its stdio: its snapshot's, where it
   * held the old ones, which CRIU replaced.
   */
  stdioFds?: [number, number, number];
  listeners: Set<TransportChunkListener>;
  exitListeners: Set<TransportExitListener>;
  internalExitWaiters: Set<TransportExitListener>;
  rawChunks: Uint8Array[];
  rawByteLength: number;
  stdoutScanDecoder: TextDecoder;
  promptScanTail: string;
  promptCount: number;
  waiters: Set<PromptWaiter>;
  readinessWaiters: Set<ReadinessWaiter>;
  interrupting: boolean;
  /**
   * Whether the server sent the session SIGKILL itself, as a termination
   * does: such a death is never taken for a kill for memory.
   */
  killedByServer: boolean;
  terminalError?: Error;
}

export interface ProcessTransportConfig {
  platformId: string;
  promptRe: RegExp;
  /** Runs before every spawn; a runtime that must build something does it here. */
  prepare?(): Promise<void>;
  command(input: StartSessionInput): {
    file: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  };
  interruptStrategy?: "write_ctrl_c" | "sigint" | "recycle";
  interruptProbe?(nonce: string): {
    input: string;
    expectedOutput: string;
  };
  /**
   * How long the runtime may take from its start to its first prompt:
   * DEFAULT_STARTUP_TIMEOUT_MS unless given, for a runtime that builds or
   * compiles something first.
   */
  startupTimeoutMs?: number;
  lineSubmitDelayMs?: number;
  /** False for a runtime whose processes CRIU cannot dump. */
  snapshots?: boolean;
  /** The environment's snapshotter unless given; null for none. */
  snapshotter?: ProcessSnapshotter | null;
  /**
   * What a host of `pid` that ended leaves in `scratchDir`
   * (RuntimeTransport.endedHostFiles).
   */
  endedHostFiles?(scratchDir: string, pid: number): string[];
  /**
   * Where the cgroup the server runs in is, which tells a runtime the kernel
   * killed for its memory (./memory-kills.ts): CGROUP_DIR unless given.
   */
  cgroupDir?: string;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_RECENT_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROMPT_SCAN_TAIL_CHARACTERS = 1024;
const GRACEFUL_TERMINATION_TIMEOUT_MS = 250;
const FORCED_TERMINATION_TIMEOUT_MS = 5_000;
// Once a runtime has exited, what it wrote is read until its stdio fall quiet
// for an interval, and for no more intervals than these, which bound its
// session's end where a process it started holds them and writes on.
const EXIT_DRAIN_INTERVAL_MS = 50;
const EXIT_DRAIN_INTERVALS = 20;
// How long a runtime may take from its start to its first prompt, unless it
// says otherwise. Bun, Python and C prompt within half a second, and C++,
// which loads Clang to JIT its cells, within 0.9 s, and 2.3 s on a CI runner
// whose every CPU a hog holds busy; a sandbox just restored, which loads its
// memory and files as they are touched, is slower still, and has taken more
// than 5 s. A runtime that exits fails its start at once, so this bounds only
// one that runs on and never prompts: generous, so that no start a loaded
// machine merely slows fails. Time the server is saved is not counted
// (runningTimeout).
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const RESTORE_TIMEOUT_MS = 60_000;
const RESTORE_POLL_MS = 20;

/**
 * Runs a runtime, given as its arguments, killed first for memory, once it
 * has written its stdio, as the kernel names them, to descriptor 3, and
 * closed that: the runtime, the same process, may move them as it starts, as
 * the Go host does, and what a snapshot hands new stdio in place of is what
 * they were. The names are read before `>&3` applies, which the shell does in
 * its own descriptors.
 */
const RECORD_STDIO = `${KILL_FIRST_FOR_MEMORY}; printf '%s\\n' "$(readlink /proc/$$/fd/0)" "$(readlink /proc/$$/fd/1)" "$(readlink /proc/$$/fd/2)" >&3; exec 3>&-; exec "$0" "$@"`;

// The status a POSIX shell exits with where it cannot execute a command.
const NOT_EXECUTABLE = 126;

/**
 * CRIU, at `file`, ending as the shell that has the kernel kill it first
 * (./memory-kills.ts) says it ended, `output`: where the kernel refused to
 * execute it, as it does for a process whose bounding set lacks any of the
 * capabilities CRIU's binary holds, as Node's spawn of it says that, EPERM;
 * undefined where it ended otherwise.
 */
function criuRefused(
  file: string,
  ended: CriuExit,
  output: string,
): CriuExit | undefined {
  if (
    ended.status !== NOT_EXECUTABLE ||
    !output.includes(`${file}: Operation not permitted`)
  )
    return undefined;
  const error: NodeJS.ErrnoException = new Error(`spawn ${file} EPERM`);
  error.code = "EPERM";
  return { error, status: null, signal: null };
}

/** What `pid` holds at each of `fds`, as the kernel names it, if it can be read. */
function heldStdio(
  pid: number,
  fds: readonly [number, number, number],
): [string, string, string] | undefined {
  try {
    return fds.map((fd) => readlinkSync(`/proc/${pid}/fd/${fd}`)) as [
      string,
      string,
      string,
    ];
  } catch {
    return undefined;
  }
}

function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve();
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

function countPromptMatches(value: string, promptRe: RegExp): number {
  const flags = promptRe.flags.includes("g")
    ? promptRe.flags
    : `${promptRe.flags}g`;
  return [...stripAnsi(value).matchAll(new RegExp(promptRe.source, flags))]
    .length;
}

function appendRecentOutput(state: BrokerState, bytes: Uint8Array): void {
  state.rawChunks.push(bytes);
  state.rawByteLength += bytes.byteLength;
  while (
    state.rawByteLength > MAX_RECENT_OUTPUT_BYTES &&
    state.rawChunks.length > 0
  ) {
    const first = state.rawChunks[0]!;
    const excess = state.rawByteLength - MAX_RECENT_OUTPUT_BYTES;
    if (first.byteLength <= excess) {
      state.rawChunks.shift();
      state.rawByteLength -= first.byteLength;
      continue;
    }
    state.rawChunks[0] = first.slice(excess);
    state.rawByteLength -= excess;
  }
}

/** The end of what the process printed most recently, for a failure's message. */
function recentOutput(state: BrokerState): string {
  return stripAnsi(
    Buffer.concat(
      state.rawChunks.map((chunk) => Buffer.from(chunk)),
      state.rawByteLength,
    ).toString("utf8"),
  )
    .trim()
    .slice(-4000);
}

// The failures to move the PID counter past the floor each snapshotter has
// reported: one that recurs, as where the namespace's PIDs end below the
// floor, is said once, not at every runtime's start.
const reportedFloorFailures = new WeakMap<ProcessSnapshotter, Set<string>>();

// The advance past the floor each snapshotter has under way, which every
// runtime starting meanwhile waits on.
const floorAdvances = new WeakMap<ProcessSnapshotter, Promise<boolean>>();

/**
 * Moves the PID counter past SESSION_PID_FLOOR, where it is not past it
 * already, as at a fresh container's first runtime or once it wraps in a
 * server that runs long, for the runtimes about to start, and so any snapshot
 * of them, to lie above the floor; resolves whether it did.
 */
function advancePastFloor(snapshotter: ProcessSnapshotter): Promise<boolean> {
  let advance = floorAdvances.get(snapshotter);
  if (!advance) {
    advance = snapshotter
      .advancePidsPast(SESSION_PID_FLOOR)
      .then(
        () => true,
        (error: unknown) => {
          reportFloorFailure(snapshotter, failureMessage(error));
          return false;
        },
      )
      .finally(() => floorAdvances.delete(snapshotter));
    floorAdvances.set(snapshotter, advance);
  }
  return advance;
}

function reportFloorFailure(
  snapshotter: ProcessSnapshotter,
  failure: string,
): void {
  const reported = reportedFloorFailures.get(snapshotter) ?? new Set();
  reportedFloorFailures.set(snapshotter, reported);
  if (reported.has(failure)) return;
  reported.add(failure);
  // Snapshots of them may then not restore, and their sessions come back from
  // their checkpoints instead.
  report(
    `bayma: sessions' runtimes may start below PID ${SESSION_PID_FLOOR}: ${failure}`,
  );
}

export class ProcessTransport implements RuntimeTransport {
  private readonly sessions = new Map<string, BrokerState>();

  private readonly config: ProcessTransportConfig;

  readonly snapshots?: TransportSnapshots;

  private readonly snapshotter: ProcessSnapshotter | null;

  constructor(config: ProcessTransportConfig) {
    this.config = config;
    if (
      config.lineSubmitDelayMs !== undefined &&
      (!Number.isSafeInteger(config.lineSubmitDelayMs) ||
        config.lineSubmitDelayMs < 0)
    ) {
      throw new Error("line submit delay must be a non-negative integer");
    }
    const snapshotter =
      config.snapshots === false
        ? null
        : config.snapshotter !== undefined
          ? config.snapshotter
          : processSnapshotter();
    this.snapshotter = snapshotter;
    if (snapshotter) {
      this.snapshots = {
        snapshot: (handle, directory) =>
          this.snapshot(snapshotter, handle, directory),
        restore: (input, snapshot, directory) =>
          this.restore(snapshotter, input, snapshot, directory),
        unrestorableReason: (snapshot) =>
          snapshotter.unrestorableReason(snapshot),
        unavailableReason: () => snapshotsUnavailableHere(snapshotter),
      };
    }
  }

  endedHostFiles(scratchDir: string, handle: TransportSessionHandle): string[] {
    return this.config.endedHostFiles?.(scratchDir, handle.pid) ?? [];
  }

  async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    this.assertNewSession(input.sessionId);
    await this.config.prepare?.();
    // Where no snapshot can be taken, a runtime may start anywhere.
    const snapshotter =
      this.snapshotter &&
      (await snapshotsUnavailableHere(this.snapshotter)) === undefined
        ? this.snapshotter
        : null;
    let floored = snapshotter !== null && (await advancePastFloor(snapshotter));
    this.assertNewSession(input.sessionId);
    // Checked again once the advance has ended: a counter that wrapped since,
    // as processes outside the server could wrap it, is moved past the floor
    // again. Nothing is awaited between the check that finds it past and the
    // start.
    while (floored && snapshotter?.pidsPast(SESSION_PID_FLOOR) === false) {
      floored = await advancePastFloor(snapshotter);
      this.assertNewSession(input.sessionId);
    }
    const resolved = this.config.command(input);
    const state = this.launch(
      input,
      resolved.file,
      resolved.args,
      {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
        TMPDIR: input.scratchDir,
        ...resolved.env,
      },
      this.snapshots !== undefined,
    );
    return state.handle;
  }

  private assertNewSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      throw new Error(`transport session ${sessionId} already exists`);
    }
  }

  /**
   * Start `file` for a session, leading a process group of its own, so the
   * session's processes are one tree, signalled and snapshotted together;
   * with `recordStdio`, noting the stdio it starts with; `restoring`, as CRIU
   * restoring the session's tree, which it waits on and exits as it does.
   */
  private launch(
    input: StartSessionInput,
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    recordStdio = false,
    restoring = false,
  ): BrokerState {
    const options = { cwd: input.cwd, env, detached: true };
    // Counted as it starts, so no kill before it started is taken for its own
    // (./memory-kills.ts says what the count cannot tell apart).
    const killedForMemory = watchMemoryKills(this.config.cgroupDir);
    // The kernel kills the session's processes before the server: this one,
    // what it starts, and what CRIU restores, which keeps the adjustment its
    // snapshot caught (./memory-kills.ts).
    const run = recordStdio
      ? { file: "/bin/sh", args: ["-c", RECORD_STDIO, file, ...args] }
      : killedFirstForMemory(file, args);
    const child = spawn(run.file, run.args, {
      ...options,
      stdio: recordStdio
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const handle: TransportSessionHandle = {
      sessionId: input.sessionId,
      platformId: this.config.platformId,
      pid: child.pid ?? -1,
      cols: input.cols,
      rows: input.rows,
    };

    const state: BrokerState = {
      handle,
      child,
      pid: handle.pid,
      listeners: new Set(),
      exitListeners: new Set(),
      internalExitWaiters: new Set(),
      rawChunks: [],
      rawByteLength: 0,
      stdoutScanDecoder: new TextDecoder(),
      promptScanTail: "",
      promptCount: 0,
      waiters: new Set(),
      readinessWaiters: new Set(),
      interrupting: false,
      killedByServer: false,
    };

    let chunksRead = 0;
    const onData = (chunk: Buffer, scanControlOutput: boolean) => {
      chunksRead += 1;
      // Child-process stream buffers may be pooled and reused after this
      // callback. Retained diagnostics and asynchronous listeners need an
      // owned snapshot, especially when a UTF-8 scalar spans chunks.
      const bytes = Uint8Array.from(chunk);
      appendRecentOutput(state, bytes);

      if (scanControlOutput) {
        const outputText = state.stdoutScanDecoder.decode(bytes, {
          stream: true,
        });
        const promptWindow = state.promptScanTail + outputText;
        const newPromptCount = Math.max(
          0,
          countPromptMatches(promptWindow, this.config.promptRe) -
            countPromptMatches(state.promptScanTail, this.config.promptRe),
        );
        state.promptScanTail = promptWindow.slice(-PROMPT_SCAN_TAIL_CHARACTERS);
        if (newPromptCount > 0) {
          state.promptCount += newPromptCount;
          for (const waiter of [...state.waiters]) {
            if (state.promptCount > waiter.seenPromptCount) {
              waiter.timeout.clear();
              state.waiters.delete(waiter);
              waiter.resolve();
            }
          }
        }

        for (const waiter of [...state.readinessWaiters]) {
          let scanWindow = waiter.scanTail + outputText;
          if (!waiter.acknowledged) {
            const acknowledgementIndex = scanWindow.indexOf(
              waiter.expectedText,
            );
            if (acknowledgementIndex === -1) {
              const overlapCharacters = waiter.expectedText.length - 1;
              waiter.scanTail =
                overlapCharacters === 0
                  ? ""
                  : scanWindow.slice(-overlapCharacters);
              continue;
            }
            waiter.acknowledged = true;
            scanWindow = scanWindow.slice(
              acknowledgementIndex + waiter.expectedText.length,
            );
          }
          if (countPromptMatches(scanWindow, this.config.promptRe) > 0) {
            waiter.timeout.clear();
            state.readinessWaiters.delete(waiter);
            waiter.resolve();
            continue;
          }
          waiter.scanTail = scanWindow.slice(-PROMPT_SCAN_TAIL_CHARACTERS);
        }
      }

      for (const listener of state.listeners) {
        listener(bytes);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => onData(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => onData(chunk, false));
    let exitNotified = false;
    const notifyExit = (error: Error) => {
      if (exitNotified) return;
      exitNotified = true;
      state.terminalError = error;
      for (const waiter of [...state.waiters]) {
        waiter.timeout.clear();
        state.waiters.delete(waiter);
        const output = recentOutput(state);
        waiter.reject(
          output.length > 0 ? new Error(`${error.message}\n${output}`) : error,
        );
      }
      for (const waiter of [...state.readinessWaiters]) {
        waiter.timeout.clear();
        state.readinessWaiters.delete(waiter);
        waiter.reject(error);
      }
      for (const waiter of [...state.internalExitWaiters]) {
        state.internalExitWaiters.delete(waiter);
        waiter(error);
      }
      if (!state.interrupting) {
        for (const listener of state.exitListeners) {
          try {
            listener(error);
          } catch {
            // Transport exit callbacks cannot throw through ChildProcess events.
          }
        }
      }
    };
    child.on("error", (error) => {
      notifyExit(
        new Error(
          `transport session ${input.sessionId} failed to start: ${error.message}`,
        ),
      );
    });
    child.stdin.on("error", (error) => {
      notifyExit(
        new Error(
          `transport session ${input.sessionId} stdin failed: ${error.message}`,
        ),
      );
    });
    child.stdout.on("error", (error) => {
      notifyExit(
        new Error(
          `transport session ${input.sessionId} stdout failed: ${error.message}`,
        ),
      );
    });
    child.stderr.on("error", (error) => {
      notifyExit(
        new Error(
          `transport session ${input.sessionId} stderr failed: ${error.message}`,
        ),
      );
    });
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      // Killed by the kernel for its memory, the server living on, it says so;
      // killed by the server itself, never. CRIU exits 0 as the tree it
      // restored is killed, so of a restored session any end is looked at.
      const kill =
        !state.killedByServer && (signal === "SIGKILL" || restoring)
          ? killedForMemory()
          : null;
      const how = kill
        ? `${ranOutOf(kill)} and was killed by the kernel`
        : "exited unexpectedly";
      const message = `transport session ${input.sessionId} ${how} (code=${code ?? "null"}, signal=${signal ?? "none"})`;
      notifyExit(
        kill ? new RuntimeMemoryKilled(message, kill) : new Error(message),
      );
    };
    // `close` follows process exit and the closing of all stdio streams. Exit
    // diagnostics must not decode an incomplete final UTF-8 scalar merely
    // because the OS reported process termination before Node drained pipes.
    child.on("close", ended);
    // A process the runtime started holds its stdio for as long as it lives,
    // `close` waiting on it, and writes to the runtime's stdin go on into the
    // pipe: the session ends instead once what the runtime wrote before it
    // exited, an exec's output among it, is read.
    child.on("exit", (code, signal) => {
      let intervals = 0;
      let chunksSeen = chunksRead;
      const drain = setInterval(() => {
        intervals += 1;
        if (chunksRead > chunksSeen && intervals < EXIT_DRAIN_INTERVALS) {
          chunksSeen = chunksRead;
          return;
        }
        clearInterval(drain);
        ended(code, signal);
      }, EXIT_DRAIN_INTERVAL_MS);
      child.once("close", () => clearInterval(drain));
    });

    const record = recordStdio ? (child.stdio[3] as Readable | null) : null;
    if (record) {
      let recorded = "";
      record.setEncoding("utf8");
      record.on("data", (text: string) => (recorded += text));
      record.on("end", () => {
        const links = recorded.split("\n").filter(Boolean);
        if (links.length === 3) state.stdio = links as [string, string, string];
      });
      // Unrecorded stdio only make the session's snapshot fail.
      record.on("error", () => undefined);
    }

    this.sessions.set(input.sessionId, state);
    return state;
  }

  /**
   * Dump the session's process tree, which ends it. Its output and exit
   * listeners must be gone first: the end is the dump's, not a failure's.
   */
  private async snapshot(
    snapshotter: ProcessSnapshotter,
    handle: TransportSessionHandle,
    directory: string,
  ): Promise<ProcessSnapshot> {
    const state = this.requireState(handle);
    if (state.terminalError) throw state.terminalError;
    const stdio =
      state.stdio ??
      (state.stdioFds ? heldStdio(state.pid, state.stdioFds) : undefined);
    if (!stdio) {
      throw new Error(
        `transport session ${handle.sessionId} did not record its stdio as it started`,
      );
    }
    const snapshot = snapshotter.dump(state.pid, directory, stdio);
    await waitForChildExit(state.child, FORCED_TERMINATION_TIMEOUT_MS);
    if (!childHasExited(state.child)) {
      throw new Error(
        `transport session ${handle.sessionId} did not end after its snapshot`,
      );
    }
    this.sessions.delete(handle.sessionId);
    return snapshot;
  }

  /**
   * Restore a dumped session: CRIU restores the tree, handing it the new
   * stdio this transport starts CRIU with, and stays as the tree's parent,
   * exiting as the tree does. The session is ready once CRIU records the
   * restored tree, at the prompt its runtime was dumped at.
   */
  private async restore(
    snapshotter: ProcessSnapshotter,
    input: StartSessionInput,
    snapshot: ProcessSnapshot,
    directory: string,
  ): Promise<TransportSessionHandle> {
    this.assertNewSession(input.sessionId);
    const command = snapshotter.restoreCommand(snapshot, directory);
    const failed = (ended: string, output = "") =>
      new Error(
        `restoring session ${input.sessionId} failed:\n${restoreFailure(directory, ended, output)}`,
      );
    let state: BrokerState;
    try {
      // The shell that runs CRIU would say only that it exited, of a CRIU
      // missing or not executable.
      accessSync(command.file, constants.X_OK);
      state = this.launch(
        input,
        command.file,
        command.args,
        process.env,
        false,
        true,
      );
    } catch (error) {
      throw failed(
        criuEnding({ error: error as Error, status: null, signal: null }),
      );
    }
    // How CRIU ended, should it end before the tree is restored.
    let ended: CriuExit | undefined;
    state.child.once("error", (error) => {
      ended ??= { error, status: null, signal: null };
    });
    state.child.once("exit", (status, signal) => {
      ended ??= { status, signal };
    });
    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    let restored = snapshotter.restoredPid(directory);
    while (restored === undefined) {
      if (state.terminalError || Date.now() > deadline) {
        const output = recentOutput(state);
        const refused = ended && criuRefused(command.file, ended, output);
        const failure = refused
          ? failed(criuEnding(refused))
          : failed(
              ended
                ? criuEnding(ended)
                : (state.terminalError?.message ??
                    `CRIU did not finish restoring within ${RESTORE_TIMEOUT_MS} ms`),
              output,
            );
        await this.terminate(state.handle);
        throw failure;
      }
      await sleep(RESTORE_POLL_MS);
      restored = snapshotter.restoredPid(directory);
    }
    state.pid = restored;
    state.handle.pid = restored;
    // The restored runtime holds its new stdio where it held the old, read
    // when it is snapshotted again: CRIU, which started with them, runs with
    // capabilities, so only the runtime may be looked into, once CRIU is done
    // with it.
    state.stdioFds = snapshot.stdioFds;
    return state.handle;
  }

  async write(
    handle: TransportSessionHandle,
    data: Uint8Array | string,
  ): Promise<void> {
    const state = this.requireState(handle);
    if (state.terminalError) throw state.terminalError;
    const writable = state.child.stdin;
    const chunk =
      typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    if (writable.destroyed) {
      throw new Error(`stdin closed for session ${handle.sessionId}`);
    }
    const writeChunk = async (value: Uint8Array): Promise<void> => {
      if (writable.write(value)) return;
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          writable.off("drain", onDrain);
          writable.off("error", onError);
          state.internalExitWaiters.delete(onExit);
        };
        const onDrain = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onExit: TransportExitListener = (error) => {
          cleanup();
          reject(error);
        };
        writable.once("drain", onDrain);
        writable.once("error", onError);
        state.internalExitWaiters.add(onExit);
      });
    };
    const lineSubmitDelayMs = this.config.lineSubmitDelayMs ?? 0;
    if (
      lineSubmitDelayMs > 0 &&
      chunk.byteLength > 1 &&
      chunk[chunk.byteLength - 1] === 0x0a
    ) {
      await writeChunk(chunk.subarray(0, -1));
      await sleep(lineSubmitDelayMs);
      if (state.terminalError) throw state.terminalError;
      await writeChunk(chunk.subarray(-1));
      return;
    }
    await writeChunk(chunk);
  }

  async resize(
    handle: TransportSessionHandle,
    size: { cols: number; rows: number },
  ): Promise<void> {
    const state = this.requireState(handle);
    state.handle.cols = size.cols;
    state.handle.rows = size.rows;
  }

  async subscribe(
    handle: TransportSessionHandle,
    onChunk: TransportChunkListener,
    onExit?: TransportExitListener,
  ): Promise<() => void> {
    const state = this.requireState(handle);
    if (state.terminalError) throw state.terminalError;
    state.listeners.add(onChunk);
    if (onExit) state.exitListeners.add(onExit);
    return () => {
      state.listeners.delete(onChunk);
      if (onExit) state.exitListeners.delete(onExit);
    };
  }

  promptCount(handle: TransportSessionHandle): number {
    return this.requireState(handle).promptCount;
  }

  private async waitForPrompt(
    handle: TransportSessionHandle,
    seenPromptCount: number,
    timeoutMs: number,
  ): Promise<void> {
    const state = this.requireState(handle);
    if (state.terminalError) throw state.terminalError;
    if (state.promptCount > seenPromptCount) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = runningTimeout(() => {
        state.waiters.delete(waiter);
        reject(
          new Error(
            `timed out waiting for prompt for ${handle.sessionId} after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);
      const waiter: PromptWaiter = {
        seenPromptCount,
        resolve,
        reject,
        timeout,
      };
      state.waiters.add(waiter);
    });
  }

  async waitForInitialPrompt(
    handle: TransportSessionHandle,
    timeoutMs?: number,
  ): Promise<void> {
    const state = this.requireState(handle);
    if (state.promptCount > 0) return;
    await this.waitForPrompt(
      handle,
      state.promptCount,
      timeoutMs ?? this.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    );
    await sleep(10);
  }

  async interrupt(
    handle: TransportSessionHandle,
    timeoutMs = 1500,
  ): Promise<"soft" | "recycle"> {
    const state = this.sessions.get(handle.sessionId);
    if (!state || state.handle !== handle) return "recycle";
    if (this.config.interruptStrategy === "recycle") return "recycle";
    const seenPromptCount = state.promptCount;
    state.interrupting = true;
    try {
      try {
        if (this.config.interruptStrategy === "sigint") {
          this.signal(state, "SIGINT");
        } else {
          await this.write(handle, "\u0003");
        }
        await this.waitForPrompt(handle, seenPromptCount, timeoutMs);
        if (this.config.interruptProbe) {
          const probe = this.config.interruptProbe(randomUUID());
          if (!probe.input || !probe.expectedOutput) {
            throw new Error(
              "interrupt probe input and expected output are required",
            );
          }
          const readiness = this.waitForProbeReadiness(
            state,
            probe.expectedOutput,
            timeoutMs,
          );
          try {
            await this.write(handle, probe.input);
            await readiness.promise;
          } finally {
            readiness.cancel();
          }
        }
        if (state.terminalError) return "recycle";
        return "soft";
      } catch {
        return "recycle";
      }
    } finally {
      state.interrupting = false;
    }
  }

  async terminate(handle: TransportSessionHandle): Promise<void> {
    const state = this.sessions.get(handle.sessionId);
    if (!state || state.handle !== handle) return;
    const processStarted = state.child.pid !== undefined;
    if (processStarted && !childHasExited(state.child)) {
      this.signal(state, "SIGTERM");
      await waitForChildExit(state.child, GRACEFUL_TERMINATION_TIMEOUT_MS);
      // Whatever the session started goes with it.
      this.signal(state, "SIGKILL");
      // A restored session's CRIU exits once its tree has; it goes too.
      if (!childHasExited(state.child)) {
        state.killedByServer = true;
        state.child.kill("SIGKILL");
      }
      if (!childHasExited(state.child)) {
        await waitForChildExit(state.child, FORCED_TERMINATION_TIMEOUT_MS);
      }
    } else if (
      processStarted &&
      !(state.child.stdout.closed && state.child.stderr.closed)
    ) {
      // The runtime has exited, and what it started holds its stdio still:
      // that goes too. Its group keeps the runtime's PID as long as any of it
      // lives.
      this.signal(state, "SIGKILL");
    }
    if (processStarted && !childHasExited(state.child)) {
      throw new Error(
        `transport session ${handle.sessionId} did not exit within ${FORCED_TERMINATION_TIMEOUT_MS} ms of forced termination`,
      );
    }
    if (this.sessions.get(handle.sessionId) === state) {
      this.sessions.delete(handle.sessionId);
    }
  }

  async shutdown(): Promise<void> {
    const handles = [...this.sessions.values()].map(
      (session) => session.handle,
    );
    const failures: unknown[] = [];
    for (const handle of handles) {
      try {
        await this.terminate(handle);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw aggregateFailure("transport shutdown failed", failures);
    }
  }

  private requireState(handle: TransportSessionHandle): BrokerState {
    const state = this.sessions.get(handle.sessionId);
    if (!state || state.handle !== handle) {
      throw new Error(`unknown or stale transport session ${handle.sessionId}`);
    }
    return state;
  }

  /** Signal the session's process group, which its runtime leads. */
  private signal(state: BrokerState, signal: NodeJS.Signals): void {
    if (state.pid <= 0) return;
    if (signal === "SIGKILL") state.killedByServer = true;
    try {
      process.kill(-state.pid, signal);
    } catch (error) {
      // Nothing is left to signal: the group is gone.
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
  }

  private waitForProbeReadiness(
    state: BrokerState,
    expectedText: string,
    timeoutMs: number,
  ): { promise: Promise<void>; cancel: () => void } {
    let waiter: ReadinessWaiter;
    const promise = new Promise<void>((resolve, reject) => {
      const timeout = runningTimeout(() => {
        state.readinessWaiters.delete(waiter);
        reject(
          new Error(
            `timed out waiting for interrupt readiness probe for ${state.handle.sessionId}`,
          ),
        );
      }, timeoutMs);
      waiter = {
        expectedText,
        scanTail: "",
        acknowledged: false,
        resolve,
        reject,
        timeout,
      };
      state.readinessWaiters.add(waiter);
    });
    return {
      promise,
      cancel: () => {
        waiter.timeout.clear();
        state.readinessWaiters.delete(waiter);
      },
    };
  }
}
