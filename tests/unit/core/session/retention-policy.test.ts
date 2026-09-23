import { expect, test } from "bun:test";
import {
  pickEvictionCandidate,
  shouldWarn,
  validateRetentionPolicy,
  validateSessionManagerOptions,
} from "@bayma/core";

test("the retention policy evicts the oldest detached idle session first", () => {
  expect(shouldWarn({ maxSessions: 10, warnUsagePercent: 70 }, 7)).toBe(true);
  expect(shouldWarn({ maxSessions: 10, warnUsagePercent: 70 }, 10)).toBe(true);

  const victim = pickEvictionCandidate([
    {
      sessionId: "busy",
      createdAtMs: 1,
      busy: true,
      status: "live_busy",
    },
    {
      sessionId: "older",
      createdAtMs: 2,
      busy: false,
      status: "live_idle",
    },
    {
      sessionId: "newer",
      createdAtMs: 3,
      busy: false,
      status: "live_idle",
    },
  ]);
  expect(victim?.sessionId).toBe("older");

  expect(() =>
    validateRetentionPolicy({ maxSessions: Number.NaN, warnUsagePercent: 70 }),
  ).toThrow("maxSessions must be a positive safe integer");
  expect(() =>
    validateRetentionPolicy({ maxSessions: 10, warnUsagePercent: 101 }),
  ).toThrow("warnUsagePercent must be between 0 and 100");
  expect(() =>
    validateSessionManagerOptions({
      maxSessions: 10,
      warnUsagePercent: 75,
      defaultCols: Number.NaN,
      defaultRows: 40,
    }),
  ).toThrow("defaultCols must be an integer between 1 and 65535");
});
