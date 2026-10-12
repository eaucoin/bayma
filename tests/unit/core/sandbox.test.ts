import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  markSandboxResumed,
  markSandboxSaved,
  resumesWithin,
  runningTimeout,
  sandboxSaved,
} from "@bayma/core";

// The clocks of a sandbox restored after an hour saved jump on by the hour:
// on a fake clock, advancing past every timeout armed before the save.

const HOUR_MS = 3_600_000;

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  markSandboxResumed();
  jest.useRealTimers();
});

/** Lets the promise callbacks the timers set off run. */
const settle = () => Promise.resolve().then(() => undefined);

test("a timeout ends as setTimeout's does while the server is not saved", () => {
  let ended = 0;
  runningTimeout(() => (ended += 1), 1_000);
  jest.advanceTimersByTime(999);
  expect(ended).toBe(0);
  jest.advanceTimersByTime(1);
  expect(ended).toBe(1);
});

test("a timeout that would end while the server is saved starts again, whole, once it resumes", async () => {
  let ended = 0;
  runningTimeout(() => (ended += 1), 1_000);
  jest.advanceTimersByTime(400);
  markSandboxSaved();
  expect(sandboxSaved()).toBe(true);
  // Restored an hour later, before the server hears of it.
  jest.advanceTimersByTime(HOUR_MS);
  await settle();
  expect(ended).toBe(0);

  markSandboxResumed();
  await settle();
  jest.advanceTimersByTime(999);
  expect(ended).toBe(0);
  jest.advanceTimersByTime(1);
  expect(ended).toBe(1);
});

test("a cleared timeout never ends, even once the server resumes", async () => {
  let ended = 0;
  const timeout = runningTimeout(() => (ended += 1), 1_000);
  markSandboxSaved();
  jest.advanceTimersByTime(HOUR_MS);
  timeout.clear();
  markSandboxResumed();
  await settle();
  jest.advanceTimersByTime(HOUR_MS);
  expect(ended).toBe(0);
});

test("a saved server resumes within a time it runs, or does not", async () => {
  expect(await resumesWithin(1_000)).toBe(true);

  markSandboxSaved();
  const resumed = resumesWithin(3_000);
  jest.advanceTimersByTime(2_000);
  markSandboxResumed();
  expect(await resumed).toBe(true);

  markSandboxSaved();
  const given = resumesWithin(3_000);
  jest.advanceTimersByTime(3_000);
  expect(await given).toBe(false);
  expect(sandboxSaved()).toBe(true);
});

test("a jump of the clocks counts a second at most toward a saved server's resume", async () => {
  // A fake clock fires every second it is advanced by; a restored process's
  // clocks jump instead, as they do for one held still for that long.
  jest.useRealTimers();
  markSandboxSaved();
  const resumed = resumesWithin(2_000);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
  const pending = new Promise((resolve) =>
    setTimeout(() => resolve("pending"), 500),
  );
  expect(await Promise.race([resumed, pending])).toBe("pending");
  markSandboxResumed();
  expect(await resumed).toBe(true);
}, 10_000);
