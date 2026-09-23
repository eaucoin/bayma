import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { aggregateFailure } from "../errors.ts";
import type {
  RuntimeTransport,
  StartSessionInput,
  TransportChunkListener,
  TransportExitListener,
  TransportSessionHandle,
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
  child: ChildProcessWithoutNullStreams;
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
  ownsProcessTree?: boolean;
  interruptProbe?(nonce: string): {
    input: string;
    expectedOutput: string;
  };
  promptTimeoutMs?: number;
  lineSubmitDelayMs?: number;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_RECENT_OUTPUT_BYTES = 4 * 1024 * 1024;
const PROMPT_SCAN_TAIL_CHARACTERS = 1024;
const GRACEFUL_TERMINATION_TIMEOUT_MS = 250;
const FORCED_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 5_000;

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

export class ProcessTransport implements RuntimeTransport {
  private readonly sessions = new Map<string, BrokerState>();

  private readonly config: ProcessTransportConfig;

  constructor(config: ProcessTransportConfig) {
    this.config = config;
    if (
      config.lineSubmitDelayMs !== undefined &&
      (!Number.isSafeInteger(config.lineSubmitDelayMs) ||
        config.lineSubmitDelayMs < 0)
    ) {
      throw new Error("line submit delay must be a non-negative integer");
    }
  }

  async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`transport session ${input.sessionId} already exists`);
    }
    await this.config.prepare?.();
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`transport session ${input.sessionId} already exists`);
    }
    const resolved = this.config.command(input);
    const child = spawn(resolved.file, resolved.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        TERM: process.env.TERM || "xterm-256color",
        ...resolved.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.config.ownsProcessTree,
    });

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
        const recentOutput = stripAnsi(
          Buffer.concat(
            state.rawChunks.map((chunk) => Buffer.from(chunk)),
            state.rawByteLength,
          ).toString("utf8"),
        )
          .trim()
          .slice(-4000);
        waiter.reject(
          recentOutput.length > 0
            ? new Error(`${error.message}\n${recentOutput}`)
            : error,
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

    this.sessions.set(input.sessionId, state);
    return handle;
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
      if (this.config.ownsProcessTree) {
        this.signal(state, "SIGKILL");
      } else if (!childHasExited(state.child)) {
        state.child.kill("SIGKILL");
      }
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

  private signal(state: BrokerState, signal: NodeJS.Signals): void {
    if (this.config.ownsProcessTree && state.child.pid) {
      try {
        process.kill(-state.child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      return;
    }
    state.child.kill(signal);
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
