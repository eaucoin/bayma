import {
  execTimestampAtOrAfterHistory,
  type ExecInterruptionReason,
  type ExecRecord,
} from "./exec-types.ts";

export interface ReconciledExecHistory {
  history: ExecRecord[];
  interruptedCount: number;
}

export function reconcileOrphanedExecs(
  history: ExecRecord[],
  recoveredAtMs: number,
  interruptionReason: ExecInterruptionReason = "server_restart",
): ReconciledExecHistory {
  let interruptedCount = 0;
  const reconciled = history.map((record) => {
    if (record.status !== "queued" && record.status !== "running") {
      return record;
    }
    interruptedCount += 1;
    const durationOrigin = record.startedAtMs ?? record.submittedAtMs;
    const finishedAtMs = execTimestampAtOrAfterHistory(record, recoveredAtMs);
    return {
      ...record,
      status: "interrupted" as const,
      finishedAtMs,
      durationMs:
        record.status === "queued" ? 0 : finishedAtMs - durationOrigin,
      interruptionReason,
    };
  });
  return { history: reconciled, interruptedCount };
}
