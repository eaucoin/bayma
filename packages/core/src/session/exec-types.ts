export const EXEC_STATUSES = [
  "queued",
  "running",
  "ok",
  "error",
  "interrupted",
] as const;
export type ExecStatus = (typeof EXEC_STATUSES)[number];
export const EXEC_INTERRUPTION_REASONS = [
  "controller_request",
  "server_restart",
  "runtime_stopped",
] as const;
export type ExecInterruptionReason = (typeof EXEC_INTERRUPTION_REASONS)[number];

export const EXEC_MESSAGE_KINDS = [
  "stdout",
  "stderr",
  "result",
  "error",
] as const;
export type ExecMessageKind = (typeof EXEC_MESSAGE_KINDS)[number];

export interface ExecMessageRecord {
  seq: number;
  messageId: string;
  kind: ExecMessageKind;
  text: string;
  occurredAtMs: number;
}

export interface ExecRecord {
  execId: string;
  code: string;
  status: ExecStatus;
  submittedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  durationMs?: number;
  interruptionReason?: ExecInterruptionReason;
  messages: ExecMessageRecord[];
}

export function execTimestampAtOrAfterHistory(
  record: ExecRecord,
  observedAtMs: number,
): number {
  return Math.max(
    observedAtMs,
    record.submittedAtMs,
    record.startedAtMs ?? 0,
    record.messages.at(-1)?.occurredAtMs ?? 0,
  );
}
