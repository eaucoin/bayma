import { readFileSync, statSync } from "node:fs";
import { failureDetail } from "../errors.ts";
import type { RuntimeCheckpointCommit } from "./checkpoint-store.ts";
import type { SessionEvent } from "./events.ts";
import type {
  ExecImage,
  ExecImageMimeType,
  ExecMessageRecord,
  ExecRecord,
  ExecStatus,
} from "./exec-types.ts";
import type { RuntimeExecEnvelope } from "../runtime/adapter.ts";
import {
  boundRuntimeText,
  RUNTIME_OUTPUT_CAPTURE_POLICY,
} from "../runtime/output-capture.ts";

// What one running exec accumulates from its runtime's envelopes: bounded
// durable messages, the images they show, the completion status, and exactly
// one checkpoint outcome. The session manager owns persistence and
// notification; this owns the capture policy.

export type ExecCompletionStatus = Extract<
  ExecStatus,
  "ok" | "error" | "interrupted"
>;
export type CheckpointOutcome = "none" | "commit" | "preserved" | "invalid";

/** Keeps the bytes of the image a message shows. */
export type ExecImageSink = (messageId: string, bytes: Uint8Array) => void;

/** How each image format's files begin. */
const IMAGE_SIGNATURES: readonly {
  mimeType: ExecImageMimeType;
  matches: (bytes: Uint8Array) => boolean;
}[] = [
  {
    mimeType: "image/png",
    matches: (bytes) => startsWith(bytes, 0, "\x89PNG\r\n\x1a\n"),
  },
  {
    mimeType: "image/jpeg",
    matches: (bytes) => startsWith(bytes, 0, "\xff\xd8\xff"),
  },
  {
    mimeType: "image/gif",
    matches: (bytes) =>
      startsWith(bytes, 0, "GIF87a") || startsWith(bytes, 0, "GIF89a"),
  },
  {
    mimeType: "image/webp",
    matches: (bytes) =>
      startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP"),
  },
];

function startsWith(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  );
}

/** The format of an image's bytes, which say what they are, or undefined. */
export function imageMimeType(
  bytes: Uint8Array,
): ExecImageMimeType | undefined {
  return IMAGE_SIGNATURES.find(({ matches }) => matches(bytes))?.mimeType;
}

export function appendExecMessage(
  record: ExecRecord,
  kind: ExecMessageRecord["kind"],
  text: string,
  image?: ExecImage,
): ExecMessageRecord {
  const seq = record.messages.length + 1;
  const observedAtMs = Math.max(
    Date.now(),
    record.startedAtMs ?? record.submittedAtMs,
    record.messages.at(-1)?.occurredAtMs ?? 0,
  );
  const message: ExecMessageRecord = {
    seq,
    messageId: `${record.execId}_${seq}`,
    kind,
    text,
    occurredAtMs:
      record.finishedAtMs === undefined
        ? observedAtMs
        : Math.min(observedAtMs, record.finishedAtMs),
    ...(image ? { image } : {}),
  };
  record.messages.push(message);
  return message;
}

/** The notification that mirrors one durable exec message. */
export function execMessageEvent(
  sessionId: string,
  execId: string,
  message: ExecMessageRecord,
): SessionEvent {
  const identity = {
    sessionId,
    execId,
    seq: message.seq,
    messageId: message.messageId,
  };
  if (message.kind === "image") {
    // An image is announced; its bytes are read from its resource.
    return { type: "exec/image", ...identity, ...message.image! };
  }
  return { type: `exec/${message.kind}`, ...identity, text: message.text };
}

export function execFinishedEvent(
  sessionId: string,
  record: ExecRecord,
): SessionEvent {
  return {
    type: "exec/finished",
    sessionId,
    execId: record.execId,
    status: record.status as ExecCompletionStatus,
    durationMs: record.durationMs ?? 0,
    messageCount: record.messages.length,
  };
}

/** Stamp the terminal status and timing on a settling exec. */
export function finishExec(
  record: ExecRecord,
  status: ExecCompletionStatus,
  finishedAtMs: number,
): void {
  record.status = status;
  record.finishedAtMs = finishedAtMs;
  record.durationMs = record.startedAtMs
    ? Math.max(0, finishedAtMs - record.startedAtMs)
    : 0;
}

export class ExecOutputCapture {
  completionStatus: ExecCompletionStatus = "ok";
  checkpointOutcome: CheckpointOutcome = "none";
  checkpointCommit?: RuntimeCheckpointCommit;
  private capturedBytes = 0;
  private capturedMessages = 0;
  private capturedImages = 0;
  private capturedImageBytes = 0;
  private stopped = false;
  private terminalErrorCapturedAfterLimit = false;

  readonly record: ExecRecord;
  private readonly runtimeId: string;
  private readonly keepImage: ExecImageSink;

  constructor(record: ExecRecord, runtimeId: string, keepImage: ExecImageSink) {
    this.record = record;
    this.runtimeId = runtimeId;
    this.keepImage = keepImage;
  }

  /** Apply runtime envelopes; returns the durable messages they produced. */
  consume(envelopes: RuntimeExecEnvelope[]): ExecMessageRecord[] {
    const messages: ExecMessageRecord[] = [];
    for (const envelope of envelopes) {
      if (
        envelope.kind === "checkpoint" ||
        envelope.kind === "checkpoint-preserved"
      ) {
        this.consumeCheckpointOutcome(envelope);
        continue;
      }
      if (envelope.kind === "done") continue;
      if (envelope.kind === "image") {
        messages.push(...this.consumeImage(envelope.payloadPath!));
        continue;
      }
      if (
        envelope.kind === "error" &&
        this.completionStatus !== "interrupted"
      ) {
        this.completionStatus = "error";
      }
      messages.push(...this.appendBounded(envelope.kind, envelope.text ?? ""));
    }
    return messages;
  }

  private consumeCheckpointOutcome(envelope: RuntimeExecEnvelope): void {
    if (this.checkpointOutcome !== "none") {
      this.checkpointCommit = undefined;
      this.checkpointOutcome = "invalid";
      this.completionStatus = "error";
      appendExecMessage(
        this.record,
        "error",
        `runtime ${this.runtimeId} emitted more than one checkpoint outcome for one exec`,
      );
      return;
    }
    if (envelope.kind === "checkpoint-preserved") {
      this.checkpointOutcome = "preserved";
    } else if (envelope.checkpoint) {
      this.checkpointOutcome = "commit";
      this.checkpointCommit = envelope.checkpoint;
    } else if (envelope.text !== undefined) {
      this.checkpointOutcome = "commit";
      try {
        this.checkpointCommit = {
          runtimeId: this.runtimeId,
          codecId: "json-v1",
          codecVersion: 1,
          payloadKind: "json-inline",
          inlineJson: JSON.parse(envelope.text),
          compatibility: {},
        };
      } catch (error) {
        this.completionStatus = "error";
        appendExecMessage(this.record, "error", failureDetail(error));
      }
    }
  }

  /**
   * Keep a copy of an image the runtime wrote, while its file is still in
   * place, if it is one of the formats a model reads and within the policy's
   * limits; otherwise say why not, on stderr.
   */
  private consumeImage(payloadPath: string): ExecMessageRecord[] {
    const policy = RUNTIME_OUTPUT_CAPTURE_POLICY;
    const refuse = (reason: string) =>
      this.appendBounded("stderr", `Bayma did not show an image: ${reason}\n`);
    if (this.capturedImages >= policy.maxExecImages) {
      return refuse(`an exec shows at most ${policy.maxExecImages} images`);
    }
    let bytes: Buffer;
    try {
      if (statSync(payloadPath).size > policy.maxImageBytes) {
        return refuse(`an image holds at most ${policy.maxImageBytes} bytes`);
      }
      bytes = readFileSync(payloadPath);
    } catch (error) {
      return refuse(failureDetail(error));
    }
    if (this.capturedImageBytes + bytes.byteLength > policy.maxExecImageBytes) {
      return refuse(
        `an exec's images hold at most ${policy.maxExecImageBytes} bytes together`,
      );
    }
    const mimeType = imageMimeType(bytes);
    if (!mimeType) return refuse("it is not a PNG, JPEG, GIF, or WebP image");
    const message = appendExecMessage(this.record, "image", "", {
      mimeType,
      byteLength: bytes.byteLength,
    });
    this.keepImage(message.messageId, bytes);
    this.capturedImages += 1;
    this.capturedImageBytes += bytes.byteLength;
    return [message];
  }

  /**
   * Retain at most the policy's bytes and messages for one exec, followed by
   * one notice; after that only one terminal error is kept so a failed exec
   * cannot read as a success.
   */
  private appendBounded(
    kind: ExecMessageRecord["kind"],
    text: string,
  ): ExecMessageRecord[] {
    if (this.stopped) {
      if (kind !== "error" || this.terminalErrorCapturedAfterLimit) return [];
      this.terminalErrorCapturedAfterLimit = true;
      return [
        appendExecMessage(this.record, kind, boundRuntimeText(text).text),
      ];
    }
    const remainingBytes =
      RUNTIME_OUTPUT_CAPTURE_POLICY.maxExecBytes - this.capturedBytes;
    if (
      remainingBytes <= 0 ||
      this.capturedMessages >= RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessages
    ) {
      this.stopped = true;
      return [this.appendCaptureNotice()];
    }
    const bounded = boundRuntimeText(
      text,
      Math.min(remainingBytes, RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessageBytes),
    );
    const message = appendExecMessage(this.record, kind, bounded.text);
    this.capturedBytes += Buffer.byteLength(bounded.text);
    this.capturedMessages += 1;
    const messages = [message];
    if (
      this.capturedBytes >= RUNTIME_OUTPUT_CAPTURE_POLICY.maxExecBytes ||
      this.capturedMessages >= RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessages
    ) {
      this.stopped = true;
      messages.push(this.appendCaptureNotice());
    }
    return messages;
  }

  private appendCaptureNotice(): ExecMessageRecord {
    return appendExecMessage(
      this.record,
      "stderr",
      `Bayma stopped retaining runtime output after ${RUNTIME_OUTPUT_CAPTURE_POLICY.maxExecBytes} bytes or ${RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessages} messages.`,
    );
  }
}
