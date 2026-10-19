import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  filesClosed,
  holdingFiles,
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

/** Lets the server read what came, as it does after the timers came due. */
const polled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a timeout ends as setTimeout's does while the server is not saved, once the server has read what came by then", async () => {
  let ended = 0;
  runningTimeout(() => (ended += 1), 1_000);
  jest.advanceTimersByTime(999);
  await polled();
  expect(ended).toBe(0);
  jest.advanceTimersByTime(1);
  expect(ended).toBe(0);
  await polled();
  expect(ended).toBe(1);
});

test("a timeout cleared by what the server read once it came due does not end", async () => {
  let ended = 0;
  const timeout = runningTimeout(() => (ended += 1), 1_000);
  jest.advanceTimersByTime(1_000);
  timeout.clear();
  await polled();
  expect(ended).toBe(0);
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
  await polled();
  expect(ended).toBe(0);
  jest.advanceTimersByTime(1);
  await polled();
  expect(ended).toBe(1);
});

test("a timeout that came due as the server was saved, by what it read then, starts again, whole, once it resumes", async () => {
  let ended = 0;
  runningTimeout(() => (ended += 1), 1_000);
  jest.advanceTimersByTime(1_000);
  // The poll that follows reads the request to save the server.
  markSandboxSaved();
  await polled();
  expect(ended).toBe(0);

  markSandboxResumed();
  await settle();
  jest.advanceTimersByTime(999);
  await polled();
  expect(ended).toBe(0);
  jest.advanceTimersByTime(1);
  await polled();
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

test("work that holds files open runs while the server is not saved, and a save waits for what runs to end", async () => {
  const done: string[] = [];
  let finish = () => {};
  const running = holdingFiles(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          done.push("first");
          resolve();
        };
      }),
  );
  await settle();
  markSandboxSaved();
  let closed = false;
  void filesClosed().then(() => (closed = true));
  // Saved, no other starts.
  const waiting = holdingFiles(async () => void done.push("second"));
  await settle();
  expect(closed).toBe(false);
  finish();
  await running;
  await settle();
  expect(closed).toBe(true);
  expect(done).toEqual(["first"]);

  markSandboxResumed();
  await waiting;
  expect(done).toEqual(["first", "second"]);
  expect(
    await Promise.race([
      filesClosed().then(() => true),
      settle().then(() => false),
    ]),
  ).toBe(true);
});
