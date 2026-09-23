import { setTimeout as sleep } from "node:timers/promises";
import type { RuntimeId } from "../runtime/id.ts";
import type { ExecMessageRecord, ExecStatus } from "../session/exec-types.ts";
import type { SessionManager } from "../session/session-manager.ts";
import {
  approxBytesForTokens,
  approxTokenCount,
  truncateTextToByteBudget,
} from "./truncate.ts";

const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
export const MAX_EXEC_YIELD_TIME_MS = 300_000;
export const MAX_SNAPSHOT_OUTPUT_TOKENS = 1_048_576;

export function validateSnapshotTokenLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_SNAPSHOT_OUTPUT_TOKENS
  ) {
    throw new Error(
      `snapshot token limit must be an integer between 1 and ${MAX_SNAPSHOT_OUTPUT_TOKENS}`,
    );
  }
  return value;
}

export function validateExecFromSeq(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("exec snapshot fromSeq must be a positive safe integer");
  }
  return value;
}

function validateYieldTimeMs(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_EXEC_YIELD_TIME_MS
  ) {
    throw new Error(
      `yield time must be an integer between 0 and ${MAX_EXEC_YIELD_TIME_MS} milliseconds`,
    );
  }
  return value;
}

export interface ExecSnapshot {
  session_id: string;
  exec_id: string;
  runtime: RuntimeId;
  status: ExecStatus;
  done: boolean;
  wall_time_seconds: number;
  from_seq: number;
  next_seq: number;
  changed: boolean;
  truncated: boolean;
  original_token_count?: number;
  stdout_text: string;
  stderr_text: string;
  result_text: string;
  error_text: string;
}

export interface ExecSnapshotOptions {
  fromSeq?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  defaultMaxOutputTokens: number;
}

export interface RenderedExecText {
  stdoutText: string;
  stderrText: string;
  resultText: string;
  errorText: string;
}

interface ProjectedExecText {
  rendered: RenderedExecText;
  truncated: boolean;
  originalTokenCount?: number;
}

const RENDERED_CHANNELS = [
  "stdoutText",
  "stderrText",
  "resultText",
  "errorText",
] as const satisfies readonly (keyof RenderedExecText)[];

export function renderExecText(
  messages: ExecMessageRecord[],
): RenderedExecText {
  const rendered: RenderedExecText = {
    stdoutText: "",
    stderrText: "",
    resultText: "",
    errorText: "",
  };

  for (const message of messages) {
    switch (message.kind) {
      case "stdout":
        rendered.stdoutText += message.text;
        break;
      case "stderr":
        rendered.stderrText += message.text;
        break;
      case "result":
        rendered.resultText = appendText(rendered.resultText, message.text);
        break;
      case "error":
        rendered.errorText = appendText(rendered.errorText, message.text);
        break;
    }
  }

  return rendered;
}

export function renderExecTextContent(rendered: RenderedExecText): string {
  const segments = [
    rendered.stdoutText,
    rendered.stderrText,
    rendered.resultText,
    rendered.errorText,
  ].filter((segment) => segment.length > 0);

  return segments
    .flatMap((segment) => {
      const normalized = segment.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const parts = normalized.split("\n");
      if (parts.at(-1) === "") parts.pop();
      return parts.length > 0 ? parts : [""];
    })
    .join("\n");
}

export function renderExecSnapshotText(
  snapshot: Pick<
    ExecSnapshot,
    "stdout_text" | "stderr_text" | "result_text" | "error_text"
  >,
): string {
  return renderExecTextContent({
    stdoutText: snapshot.stdout_text,
    stderrText: snapshot.stderr_text,
    resultText: snapshot.result_text,
    errorText: snapshot.error_text,
  });
}

export function projectExecText(
  rendered: RenderedExecText,
  maxOutputTokens: number,
): ProjectedExecText {
  validateSnapshotTokenLimit(maxOutputTokens);
  const normalized: RenderedExecText = {
    stdoutText: normalizeNewlines(rendered.stdoutText),
    stderrText: normalizeNewlines(rendered.stderrText),
    resultText: normalizeNewlines(rendered.resultText),
    errorText: normalizeNewlines(rendered.errorText),
  };
  const byteLengths = RENDERED_CHANNELS.map((channel) =>
    Buffer.byteLength(normalized[channel], "utf8"),
  );
  const totalBytes = byteLengths.reduce((sum, length) => sum + length, 0);
  const maxBytes = approxBytesForTokens(maxOutputTokens);
  if (totalBytes <= maxBytes) {
    return { rendered: normalized, truncated: false };
  }

  const budgets = allocateChannelBytes(byteLengths, maxBytes);
  const projected = {} as RenderedExecText;
  for (const [index, channel] of RENDERED_CHANNELS.entries()) {
    projected[channel] = truncateTextToByteBudget(
      normalized[channel],
      budgets[index] ?? 0,
    ).text;
  }
  return {
    rendered: projected,
    truncated: true,
    originalTokenCount: approxTokenCount(renderExecTextContent(normalized)),
  };
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function collectExecSnapshot(
  manager: SessionManager,
  sessionId: string,
  execId: string,
  options: ExecSnapshotOptions,
): Promise<ExecSnapshot> {
  const fromSeq = validateExecFromSeq(options.fromSeq ?? 1);
  const yieldTimeMs = validateYieldTimeMs(
    options.yieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS,
  );
  const pollIntervalMs = Math.min(
    DEFAULT_POLL_INTERVAL_MS,
    Math.max(1, yieldTimeMs || 1),
  );
  const startedAtMs = Date.now();
  const deadline = startedAtMs + yieldTimeMs;

  let exec = manager.exec(sessionId, execId);
  while (!isDone(exec.status) && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
    exec = manager.exec(sessionId, execId);
  }

  exec = manager.exec(sessionId, execId);
  const runtime = manager.detail(sessionId).runtimeId;
  if (!runtime) throw new Error(`session ${sessionId} has no runtime`);
  const messages = manager.execMessages(sessionId, execId, fromSeq);
  const projected = projectExecText(
    renderExecText(messages),
    options.maxOutputTokens ?? options.defaultMaxOutputTokens,
  );

  return {
    session_id: sessionId,
    exec_id: execId,
    runtime,
    status: exec.status,
    done: isDone(exec.status),
    wall_time_seconds: Math.max(0, Date.now() - startedAtMs) / 1_000,
    from_seq: fromSeq,
    next_seq: messages.length > 0 ? messages.at(-1)!.seq + 1 : fromSeq,
    changed: messages.length > 0,
    truncated: projected.truncated,
    original_token_count: projected.originalTokenCount,
    stdout_text: projected.rendered.stdoutText,
    stderr_text: projected.rendered.stderrText,
    result_text: projected.rendered.resultText,
    error_text: projected.rendered.errorText,
  };
}

function allocateChannelBytes(
  lengths: number[],
  totalBudget: number,
): number[] {
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  if (totalLength === 0 || totalBudget === 0) {
    return lengths.map(() => 0);
  }
  const allocated = lengths.map(() => 0);
  let remainingBudget = totalBudget;
  const pending = lengths
    .map((length, index) => ({ index, length }))
    .filter(({ length }) => length > 0)
    .sort(
      (left, right) => left.length - right.length || left.index - right.index,
    );

  while (
    pending.length > 0 &&
    pending[0]!.length <= remainingBudget / pending.length
  ) {
    const smallest = pending.shift()!;
    allocated[smallest.index] = smallest.length;
    remainingBudget -= smallest.length;
  }
  if (pending.length === 0) return allocated;

  const pendingLength = pending.reduce((sum, entry) => sum + entry.length, 0);
  const exact = pending.map((entry) => ({
    ...entry,
    bytes: (entry.length * remainingBudget) / pendingLength,
  }));
  for (const entry of exact) {
    allocated[entry.index] = Math.floor(entry.bytes);
  }
  let remainder =
    remainingBudget -
    exact.reduce((sum, entry) => sum + Math.floor(entry.bytes), 0);
  const largestRemaindersFirst = exact.sort((left, right) => {
    const leftRemainder = left.bytes - Math.floor(left.bytes);
    const rightRemainder = right.bytes - Math.floor(right.bytes);
    return rightRemainder - leftRemainder || left.index - right.index;
  });
  for (const entry of largestRemaindersFirst) {
    if (remainder === 0) break;
    allocated[entry.index] = (allocated[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return allocated;
}

function isDone(status: ExecStatus): boolean {
  return status === "ok" || status === "error" || status === "interrupted";
}

function appendText(existing: string, next: string): string {
  if (existing.length === 0) return next;
  if (existing.endsWith("\n") || next.startsWith("\n")) return existing + next;
  return `${existing}\n${next}`;
}
