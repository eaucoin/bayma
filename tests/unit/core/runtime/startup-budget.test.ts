import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  markSandboxResumed,
  markSandboxSaved,
  ProcessTransport,
} from "@bayma/core";

// How long a runtime may take to its first prompt, on a fake clock: the
// runtime, a shell, prompts once it reads a line, which the test writes when
// as much time as it wants has passed.

const STARTUP_BUDGET_MS = 30_000;

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  markSandboxResumed();
  jest.useRealTimers();
});

/** Lets the server read what came, as it does after the timers came due. */
const polled = () => new Promise<void>((resolve) => setImmediate(resolve));

async function startRuntime(sessionId: string) {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /READY> /g,
    command: () => ({
      file: "/bin/sh",
      args: ["-c", 'read go; printf "READY> "; sleep 30'],
    }),
    snapshotter: null,
  });
  const handle = await transport.startSession({
    sessionId,
    title: sessionId,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    scratchDir: tmpdir(),
  });
  let outcome: "starting" | "started" | Error = "starting";
  const started = transport.waitForInitialPrompt(handle).then(
    () => (outcome = "started"),
    (error: Error) => (outcome = error),
  );
  return {
    transport,
    outcome: () => outcome,
    /** Has the runtime prompt, and waits, on the fake clock, for its start. */
    async prompt() {
      await transport.write(handle, "go\n");
      while (outcome === "starting") {
        await polled();
        jest.advanceTimersByTime(1);
      }
      await started;
    },
  };
}

test("a runtime that prompts long after 5 s, within its startup budget, starts", async () => {
  const runtime = await startRuntime("sess_slow_start");
  try {
    jest.advanceTimersByTime(STARTUP_BUDGET_MS - 1_000);
    await polled();
    expect(runtime.outcome()).toBe("starting");

    await runtime.prompt();
    expect(runtime.outcome()).toBe("started");
  } finally {
    await runtime.transport.shutdown();
  }
});

test("a runtime that never prompts fails its start once its budget has passed", async () => {
  const runtime = await startRuntime("sess_no_prompt");
  try {
    jest.advanceTimersByTime(STARTUP_BUDGET_MS);
    await polled();
    expect(runtime.outcome()).toEqual(
      new Error(
        `timed out waiting for prompt for sess_no_prompt after ${STARTUP_BUDGET_MS} ms`,
      ),
    );
  } finally {
    await runtime.transport.shutdown();
  }
});

test("time the server is saved does not count against a runtime's start", async () => {
  const runtime = await startRuntime("sess_saved_start");
  try {
    jest.advanceTimersByTime(STARTUP_BUDGET_MS - 1_000);
    markSandboxSaved();
    // The budget comes due while the server is saved, its clocks jumping on.
    jest.advanceTimersByTime(3_600_000);
    await polled();
    markSandboxResumed();
    await polled();
    // And starts again, whole, as the server runs on.
    jest.advanceTimersByTime(STARTUP_BUDGET_MS - 1_000);
    await polled();
    expect(runtime.outcome()).toBe("starting");

    await runtime.prompt();
    expect(runtime.outcome()).toBe("started");
  } finally {
    await runtime.transport.shutdown();
  }
});
