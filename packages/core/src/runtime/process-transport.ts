import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readlinkSync } from "node:fs";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { aggregateFailure } from "../errors.ts";
import {
  criuEnding,
  processSnapshotter,
  restoreFailure,
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
  timeout: ReturnType<typeof setTimeout>;
}

interface ReadinessWaiter {
  expectedText: string;
  scanTail: string;
  acknowledged: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
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
  promptTimeoutMs?: number;
  lineSubmitDelayMs?: number;
  /** False for a runtime whose processes CRIU cannot dump. */
  snapshots?: boolean;
  /** The environment's snapshotter unless given; null for none. */
  snapshotter?: ProcessSnapshotter | null;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_RECENT_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROMPT_SCAN_TAIL_CHARACTERS = 1024;
const GRACEFUL_TERMINATION_TIMEOUT_MS = 250;
const FORCED_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 5_000;
const RESTORE_TIMEOUT_MS = 60_000;
const RESTORE_POLL_MS = 20;

/**
 * Runs a runtime, given as its arguments, once it has written its stdio, as
 * the kernel names them, to descriptor 3, and closed that: the runtime, the
 * same process, may move them as it starts, as the Go host does, and what a
 * snapshot hands new stdio in place of is what they were. The names are read
 * before `>&3` applies, which the shell does in its own descriptors.
 */
const RECORD_STDIO = `printf '%s\\n' "$(readlink /proc/$$/fd/0)" "$(readlink /proc/$$/fd/1)" "$(readlink /proc/$$/fd/2)" >&3; exec 3>&-; exec "$0" "$@"`;

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

export class ProcessTransport implements RuntimeTransport {
  private readonly sessions = new Map<string, BrokerState>();

  private readonly config: ProcessTransportConfig;

  readonly snapshots?: TransportSnapshots;

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
    if (snapshotter) {
      this.snapshots = {
        snapshot: (handle, directory) =>
          this.snapshot(snapshotter, handle, directory),
        restore: (input, snapshot, directory) =>
          this.restore(snapshotter, input, snapshot, directory),
        unrestorableReason: (snapshot) =>
          snapshotter.unrestorableReason(snapshot),
      };
    }
  }

  async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    this.assertNewSession(input.sessionId);
    await this.config.prepare?.();
    this.assertNewSession(input.sessionId);
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
   * with `recordStdio`, noting the stdio it starts with.
   */
  private launch(
    input: StartSessionInput,
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    recordStdio = false,
  ): BrokerState {
    const options = { cwd: input.cwd, env, detached: true };
    const child = (
      recordStdio
        ? spawn("/bin/sh", ["-c", RECORD_STDIO, file, ...args], {
            ...options,
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          })
        : spawn(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
    ) as ChildProcessWithoutNullStreams;

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
    };

    const onData = (chunk: Buffer, scanControlOutput: boolean) => {
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
              clearTimeout(waiter.timeout);
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
            clearTimeout(waiter.timeout);
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
        clearTimeout(waiter.timeout);
        state.waiters.delete(waiter);
        const output = recentOutput(state);
        waiter.reject(
          output.length > 0 ? new Error(`${error.message}\n${output}`) : error,
        );
      }
      for (const waiter of [...state.readinessWaiters]) {
        clearTimeout(waiter.timeout);
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
    // `close` follows process exit and the closing of all stdio streams. Exit
    // diagnostics must not decode an incomplete final UTF-8 scalar merely
    // because the OS reported process termination before Node drained pipes.
    child.on("close", (code, signal) => {
      notifyExit(
        new Error(
          `transport session ${input.sessionId} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
        ),
      );
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
      state = this.launch(input, command.file, command.args, process.env);
    } catch (error) {
      // Node throws the spawn errors it does not expect, EPERM among them,
      // rather than emitting them.
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
        const failure = failed(
          ended
            ? criuEnding(ended)
            : (state.terminalError?.message ??
                `CRIU did not finish restoring within ${RESTORE_TIMEOUT_MS} ms`),
          recentOutput(state),
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
    timeoutMs = this.config.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
  ): Promise<void> {
    const state = this.requireState(handle);
    if (state.terminalError) throw state.terminalError;
    if (state.promptCount > seenPromptCount) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.waiters.delete(waiter);
        reject(
          new Error(`timed out waiting for prompt for ${handle.sessionId}`),
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
    await this.waitForPrompt(handle, state.promptCount, timeoutMs);
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
      if (!childHasExited(state.child)) state.child.kill("SIGKILL");
      if (!childHasExited(state.child)) {
        await waitForChildExit(state.child, FORCED_TERMINATION_TIMEOUT_MS);
      }
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
      const timeout = setTimeout(() => {
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
        clearTimeout(waiter.timeout);
        state.readinessWaiters.delete(waiter);
      },
    };
  }
}
