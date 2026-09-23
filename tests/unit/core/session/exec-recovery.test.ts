import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import {
  reconcileOrphanedExecs,
  ExecHistoryStore,
  type ExecRecord,
} from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

test("exec recovery terminalizes orphaned execs exactly once", () => {
  const terminal: ExecRecord = {
    execId: "exec_ok",
    code: "42",
    status: "ok",
    submittedAtMs: 10,
    startedAtMs: 11,
    finishedAtMs: 12,
    durationMs: 1,
    messages: [],
  };
  const first = reconcileOrphanedExecs(
    [
      {
        execId: "exec_queued",
        code: "queued",
        status: "queued",
        submittedAtMs: 20,
        messages: [],
      },
      {
        execId: "exec_running",
        code: "running",
        status: "running",
        submittedAtMs: 30,
        startedAtMs: 40,
        messages: [
          {
            seq: 1,
            messageId: "exec_running_1",
            kind: "stdout",
            text: "before restart\n",
            occurredAtMs: 45,
          },
        ],
      },
      terminal,
    ],
    100,
  );

  expect(first.interruptedCount).toBe(2);
  expect(first.history[0]).toEqual({
    execId: "exec_queued",
    code: "queued",
    status: "interrupted",
    submittedAtMs: 20,
    finishedAtMs: 100,
    durationMs: 0,
    interruptionReason: "server_restart",
    messages: [],
  });
  expect(first.history[1]).toEqual({
    execId: "exec_running",
    code: "running",
    status: "interrupted",
    submittedAtMs: 30,
    startedAtMs: 40,
    finishedAtMs: 100,
    durationMs: 60,
    interruptionReason: "server_restart",
    messages: [
      {
        seq: 1,
        messageId: "exec_running_1",
        kind: "stdout",
        text: "before restart\n",
        occurredAtMs: 45,
      },
    ],
  });
  expect(first.history[2]).toBe(terminal);

  const second = reconcileOrphanedExecs(first.history, 200);
  expect(second.interruptedCount).toBe(0);
  expect(second.history).toEqual(first.history);
  expect(second.history[0]).toBe(first.history[0]);
  expect(second.history[1]).toBe(first.history[1]);
  expect(second.history[2]).toBe(terminal);
});

test("exec recovery never produces a negative duration", () => {
  const recovered = reconcileOrphanedExecs(
    [
      {
        execId: "exec_clock_skew",
        code: "running",
        status: "running",
        submittedAtMs: 200,
        startedAtMs: 300,
        messages: [],
      },
    ],
    100,
  );
  expect(recovered.history[0]?.durationMs).toBe(0);
});

test("exec recovery finishes after persisted output even when the clock rolled back", () => {
  const recovered = reconcileOrphanedExecs(
    [
      {
        execId: "exec_clock_rollback_after_output",
        code: "running",
        status: "running",
        submittedAtMs: 200,
        startedAtMs: 300,
        messages: [
          {
            seq: 1,
            messageId: "exec_clock_rollback_after_output_1",
            kind: "stdout",
            text: "already persisted",
            occurredAtMs: 400,
          },
        ],
      },
    ],
    100,
  );

  expect(recovered.history[0]).toMatchObject({
    status: "interrupted",
    finishedAtMs: 400,
    durationMs: 100,
  });
});

test("persisted exec history rejects reordered submissions", async () => {
  await withTempDir(async (dir) => {
    const store = new ExecHistoryStore(dir);
    const sessionId = "sess_reordered";
    writeFileSync(
      store.historyPath(sessionId),
      JSON.stringify({
        schemaVersion: 1,
        history: [
          {
            execId: "exec_second",
            code: "second",
            status: "queued",
            submittedAtMs: 20,
            messages: [],
          },
          {
            execId: "exec_first",
            code: "first",
            status: "queued",
            submittedAtMs: 10,
            messages: [],
          },
        ],
      }),
      "utf8",
    );

    expect(() => store.read(sessionId)).toThrow(
      "exec history is not ordered by nondecreasing submission time",
    );
  });
});

test("persisted exec and message identities retain their canonical grammar", async () => {
  await withTempDir(async (dir) => {
    const store = new ExecHistoryStore(dir);
    const writeHistory = (history: unknown[]) =>
      writeFileSync(
        store.historyPath("sess_identity"),
        JSON.stringify({ schemaVersion: 1, history }),
        "utf8",
      );

    writeHistory([
      {
        execId: "exec/ambiguous",
        code: "42",
        status: "queued",
        submittedAtMs: 1,
        messages: [],
      },
    ]);
    expect(() => store.read("sess_identity")).toThrow(
      "exec ID must use the safe persisted ID grammar",
    );

    writeHistory([
      {
        execId: "exec_canonical",
        code: "42",
        status: "ok",
        submittedAtMs: 1,
        startedAtMs: 1,
        finishedAtMs: 1,
        durationMs: 0,
        messages: [
          {
            seq: 1,
            messageId: "some_other_identity",
            kind: "result",
            text: "42",
            occurredAtMs: 1,
          },
        ],
      },
    ]);
    expect(() => store.read("sess_identity")).toThrow(
      "exec exec_canonical message 1 has a noncanonical message id",
    );
  });
});
