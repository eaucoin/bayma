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
  "image",
] as const;
export type ExecMessageKind = (typeof EXEC_MESSAGE_KINDS)[number];

/** The image formats an exec can show, each as its media type. */
export const EXEC_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type ExecImageMimeType = (typeof EXEC_IMAGE_MIME_TYPES)[number];

/** An image an exec showed; its bytes are kept beside the exec's history. */
export interface ExecImage {
  mimeType: ExecImageMimeType;
  byteLength: number;
}

export interface ExecMessageRecord {
  seq: number;
  messageId: string;
  kind: ExecMessageKind;
  /** The message's text; an image message has none. */
  text: string;
  occurredAtMs: number;
  /** What an image message showed, and only an image message. */
  image?: ExecImage;
}

/**
 * How a session came back after the server that ran it stopped: whole from
 * its process snapshot, or from its checkpoint.
 */
export const RECOVERY_SOURCES = ["process_snapshot", "checkpoint"] as const;
export type RecoverySource = (typeof RECOVERY_SOURCES)[number];

/**
 * How a session came back: as a session does after its server stopped, or
 * whole, with the sandbox bayma runs in, from a snapshot of the sandbox, or
 * its runtime started again, as it outgrew the runtime memory budget, or as
 * the kernel killed it for its memory.
 */
export const SESSION_RETURNS = [
  ...RECOVERY_SOURCES,
  "sandbox_snapshot",
  "memory_budget",
  "memory_kill",
] as const;
export type SessionReturn = (typeof SESSION_RETURNS)[number];

/** What an exec is told of how its session came back before it ran. */
export interface ExecNotice {
  returnedFrom: SessionReturn;
  /** When the sandbox's snapshot was taken, if bayma knows, for `sandbox_snapshot`. */
  snapshotAtMs?: number;
  /**
   * For `sandbox_snapshot`, why the sandbox was stopped before it was
   * restored, as its host said it, where it said.
   */
  stopReason?: string;
  /**
   * For `memory_budget`, a host started again as it came to hold more of its
   * own than the server's runtime memory budget past what it held as it
   * started: how much more, the budget, what the runtime keeps of each cell
   * where it keeps something, whether the session came back from its
   * checkpoint or afresh, as one that committed none does, and, where the
   * host restored from the checkpoint already held more than the budget past
   * what it started with, how much more, the budget standing down for the
   * session until it is closed.
   */
  memory?: {
    grewBytes: number;
    budgetBytes: number;
    keepsOfEachCell?: string;
    from: "checkpoint" | "fresh";
    stoodDownBytes?: number;
  };
  /**
   * For `memory_kill`, a runtime the kernel killed for its memory started
   * again: the limit it ran out of, null for none, and whether the session
   * came back from its checkpoint, committed at `checkpointAtMs`, or afresh,
   * as one that committed none does.
   */
  memoryKill?: {
    limit: string | null;
    from: "checkpoint" | "fresh";
    checkpointAtMs?: number;
  };
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
  /**
   * How the session came back, told to the first exec it runs since, or to
   * the exec it was running when the sandbox was snapshotted.
   */
  notice?: ExecNotice;
  messages: ExecMessageRecord[];
}

/** Whether an exec has yet to end: queued, or running. */
export function isPendingExec({ status }: Pick<ExecRecord, "status">): boolean {
  return status === "queued" || status === "running";
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
