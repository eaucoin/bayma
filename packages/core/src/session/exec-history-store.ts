import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as z from "zod";
import { assertSafePersistedId, SAFE_PERSISTED_ID_PATTERN } from "../ids.ts";
import {
  EXEC_INTERRUPTION_REASONS,
  EXEC_MESSAGE_KINDS,
  EXEC_STATUSES,
  type ExecRecord,
} from "./exec-types.ts";

export const EXEC_HISTORY_SCHEMA_VERSION = 1 as const;

const ExecMessageRecordSchema = z.strictObject({
  seq: z.number().int().positive(),
  messageId: z.string().min(1),
  kind: z.enum(EXEC_MESSAGE_KINDS),
  text: z.string(),
  occurredAtMs: z.number().finite().nonnegative(),
});

const ExecRecordSchema: z.ZodType<ExecRecord> = z
  .strictObject({
    execId: z
      .string()
      .regex(
        SAFE_PERSISTED_ID_PATTERN,
        "exec ID must use the safe persisted ID grammar",
      ),
    code: z.string(),
    status: z.enum(EXEC_STATUSES),
    submittedAtMs: z.number().finite().nonnegative(),
    startedAtMs: z.number().finite().nonnegative().optional(),
    finishedAtMs: z.number().finite().nonnegative().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    interruptionReason: z.enum(EXEC_INTERRUPTION_REASONS).optional(),
    messages: z.array(ExecMessageRecordSchema),
  })
  .superRefine((record, context) => {
    const terminal = ["ok", "error", "interrupted"].includes(record.status);
    if (
      (record.finishedAtMs === undefined) !==
        (record.durationMs === undefined) ||
      terminal !== (record.finishedAtMs !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: `exec ${record.execId} terminal state and completion fields disagree`,
      });
    }
    if (
      (record.status === "interrupted") !==
      (record.interruptionReason !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: `exec ${record.execId} interruption state and reason disagree`,
      });
    }
    if (
      (record.status === "queued" && record.startedAtMs !== undefined) ||
      (record.status === "running" && record.startedAtMs === undefined) ||
      (["ok", "error"].includes(record.status) &&
        record.startedAtMs === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: `exec ${record.execId} start fields disagree with status`,
      });
    }
    const durationOrigin = record.startedAtMs ?? record.submittedAtMs;
    const expectedDuration =
      record.status === "interrupted" && record.startedAtMs === undefined
        ? 0
        : record.finishedAtMs !== undefined
          ? record.finishedAtMs - durationOrigin
          : undefined;
    if (
      (record.startedAtMs !== undefined &&
        record.startedAtMs < record.submittedAtMs) ||
      (record.finishedAtMs !== undefined &&
        record.finishedAtMs < durationOrigin) ||
      (record.durationMs !== undefined &&
        record.durationMs !== expectedDuration)
    ) {
      context.addIssue({
        code: "custom",
        message: `exec ${record.execId} timing fields disagree`,
      });
    }
    const messageIds = new Set<string>();
    record.messages.forEach((message, index) => {
      const previous = record.messages[index - 1];
      if (
        message.seq !== index + 1 ||
        messageIds.has(message.messageId) ||
        message.occurredAtMs < durationOrigin ||
        (previous !== undefined &&
          message.occurredAtMs < previous.occurredAtMs) ||
        (record.finishedAtMs !== undefined &&
          message.occurredAtMs > record.finishedAtMs)
      ) {
        context.addIssue({
          code: "custom",
          message: `exec ${record.execId} messages are not a unique contiguous temporal sequence`,
        });
      }
      if (message.messageId !== `${record.execId}_${message.seq}`) {
        context.addIssue({
          code: "custom",
          message: `exec ${record.execId} message ${message.seq} has a noncanonical message id`,
        });
      }
      messageIds.add(message.messageId);
    });
    if (record.status === "queued" && record.messages.length > 0) {
      context.addIssue({
        code: "custom",
        message: `queued exec ${record.execId} may not contain messages`,
      });
    }
  });

const ExecHistorySchema = z
  .strictObject({
    schemaVersion: z.literal(EXEC_HISTORY_SCHEMA_VERSION),
    history: z.array(ExecRecordSchema),
  })
  .superRefine((value, context) => {
    const ids = value.history.map((record) => record.execId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "exec history contains duplicate exec ids",
      });
    }
    value.history.forEach((record, index) => {
      const previous = value.history[index - 1];
      if (previous && record.submittedAtMs < previous.submittedAtMs) {
        context.addIssue({
          code: "custom",
          message:
            "exec history is not ordered by nondecreasing submission time",
        });
      }
    });
  });

export class ExecHistoryStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(this.historiesDir, { recursive: true });
    mkdirSync(this.execBundlesDir, { recursive: true });
  }

  get historiesDir(): string {
    return join(this.rootDir, "histories");
  }

  get execBundlesDir(): string {
    return join(this.rootDir, "execs");
  }

  historyPath(sessionId: string): string {
    return join(
      this.historiesDir,
      `${assertSafePersistedId(sessionId, "session ID")}.json`,
    );
  }

  write(sessionId: string, history: ExecRecord[]): void {
    mkdirSync(this.historiesDir, { recursive: true });
    const validated = ExecHistorySchema.parse({
      schemaVersion: EXEC_HISTORY_SCHEMA_VERSION,
      history,
    });
    const finalPath = this.historyPath(sessionId);
    const tempPath = `${finalPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
    renameSync(tempPath, finalPath);
  }

  read(sessionId: string): ExecRecord[] {
    const path = this.historyPath(sessionId);
    if (!existsSync(path)) return [];
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    const normalized =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !("schemaVersion" in value)
        ? { schemaVersion: EXEC_HISTORY_SCHEMA_VERSION, ...value }
        : value;
    return ExecHistorySchema.parse(normalized).history;
  }

  remove(sessionId: string): void {
    rmSync(this.historyPath(sessionId), { force: true });
  }
}
