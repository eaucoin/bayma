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
