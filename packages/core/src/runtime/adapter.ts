import type { ExecRecord } from "../session/exec-types.ts";
import type {
  CheckpointPayloadKind,
  RuntimeCheckpointCommit,
  RuntimeCheckpointSnapshot,
  SessionCheckpoint,
} from "../session/checkpoint-store.ts";
import type { DurabilityMode } from "../session/model.ts";
import type { RuntimeId } from "./id.ts";
import type { RuntimeModelProfile } from "./profile.ts";
import type { RuntimeTransport } from "./transport.ts";

export type RuntimeExecEnvelopeKind =
  | "stdout"
  | "stderr"
  | "result"
  | "error"
  | "done"
  | "checkpoint"
  | "checkpoint-preserved";

export interface RuntimeExecEnvelope {
  kind: RuntimeExecEnvelopeKind;
  text?: string;
  checkpoint?: RuntimeCheckpointCommit;
}

const RUNTIME_EXEC_ENVELOPE_KINDS = new Set<RuntimeExecEnvelopeKind>([
  "stdout",
  "stderr",
  "result",
  "error",
  "done",
  "checkpoint",
  "checkpoint-preserved",
]);

function isCheckpointCommit(value: unknown): value is RuntimeCheckpointCommit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const commit = value as Record<string, unknown>;
  const compatibility = commit.compatibility;
  const payloadKind = commit.payloadKind;
  const hasInlineJson = Object.hasOwn(commit, "inlineJson");
  const hasPayloadPath = Object.hasOwn(commit, "payloadPath");
  return (
    Object.keys(commit).every((key) =>
      [
        "runtimeId",
        "codecId",
        "codecVersion",
        "payloadKind",
        "inlineJson",
        "payloadPath",
        "byteLength",
        "sha256",
        "compatibility",
      ].includes(key),
    ) &&
    typeof commit.runtimeId === "string" &&
    commit.runtimeId.length > 0 &&
    typeof commit.codecId === "string" &&
    commit.codecId.length > 0 &&
    Number.isInteger(commit.codecVersion) &&
    Number(commit.codecVersion) > 0 &&
    ["json-inline", "binary-sidecar", "text-sidecar"].includes(
      String(payloadKind),
    ) &&
    (payloadKind === "json-inline"
      ? hasInlineJson && !hasPayloadPath
      : !hasInlineJson &&
        hasPayloadPath &&
        typeof commit.payloadPath === "string" &&
        commit.payloadPath.length > 0) &&
    (commit.payloadPath === undefined ||
      (typeof commit.payloadPath === "string" &&
        commit.payloadPath.length > 0)) &&
    (commit.byteLength === undefined ||
      (Number.isInteger(commit.byteLength) &&
        Number(commit.byteLength) >= 0)) &&
    (commit.sha256 === undefined ||
      (typeof commit.sha256 === "string" &&
        /^[0-9a-f]{64}$/i.test(commit.sha256))) &&
    (compatibility === undefined ||
      (compatibility !== null &&
        typeof compatibility === "object" &&
        !Array.isArray(compatibility) &&
        Object.entries(compatibility).every(
          ([key, field]) =>
            [
              "runtimeVersion",
              "languageVersion",
              "adapterVersion",
              "platform",
              "arch",
            ].includes(key) &&
            (field === undefined || typeof field === "string"),
        )))
  );
}

export function parseRuntimeExecEnvelope(
  value: unknown,
): RuntimeExecEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).some(
      (key) => !["kind", "text", "checkpoint"].includes(key),
    ) ||
    typeof envelope.kind !== "string" ||
    !RUNTIME_EXEC_ENVELOPE_KINDS.has(
      envelope.kind as RuntimeExecEnvelopeKind,
    ) ||
    (envelope.text !== undefined && typeof envelope.text !== "string") ||
    (envelope.checkpoint !== undefined &&
      !isCheckpointCommit(envelope.checkpoint))
  ) {
    return null;
  }
  const kind = envelope.kind as RuntimeExecEnvelopeKind;
  const isMessage = ["stdout", "stderr", "result", "error"].includes(kind);
  if (
    (isMessage &&
      (typeof envelope.text !== "string" ||
        envelope.checkpoint !== undefined)) ||
    (["done", "checkpoint-preserved"].includes(kind) &&
      (envelope.text !== undefined || envelope.checkpoint !== undefined)) ||
    (kind === "checkpoint" &&
      (envelope.text === undefined) === (envelope.checkpoint === undefined))
  ) {
    return null;
  }
  return {
    kind,
    ...(typeof envelope.text === "string" ? { text: envelope.text } : {}),
    ...(isCheckpointCommit(envelope.checkpoint)
      ? { checkpoint: envelope.checkpoint }
      : {}),
  };
}

export interface RuntimeOutputState {
  done: boolean;
  envelopes: RuntimeExecEnvelope[];
}

export interface RuntimeOutputCollector {
  push(text: string): RuntimeOutputState;
  finish(): RuntimeOutputState;
}

export interface PrepareExecInput {
  rootDir: string;
  sessionId: string;
  execId: string;
  code: string;
  durabilityMode: DurabilityMode;
  checkpoint?: RuntimeCheckpointSnapshot | null;
}

export interface PreparedExec {
  submitText: string;
  collector: RuntimeOutputCollector;
  dispose?: () => void;
}

export interface RuntimeDoctor {
  probeCode: string;
  successMessage: string;
  assertSuccess(exec: ExecRecord): void;
}

export function assertDoctorExecResult(
  exec: ExecRecord,
  expectedResult: string,
): void {
  if (exec.status !== "ok") {
    throw new Error(`doctor exec ended with status ${exec.status}`);
  }
  const results = exec.messages.filter((message) => message.kind === "result");
  if (results.length !== 1 || results[0]?.text.trim() !== expectedResult) {
    throw new Error("doctor exec completed without the exact expected result");
  }
}

export interface RuntimeCheckpointCodec {
  codecId: string;
  codecVersion: number;
  payloadKind: CheckpointPayloadKind;
}

export const JSON_CHECKPOINT_CODEC = {
  codecId: "json-v1",
  codecVersion: 1,
  payloadKind: "json-inline",
} as const satisfies RuntimeCheckpointCodec;

type RuntimeCheckpointDescriptor = Pick<
  SessionCheckpoint | RuntimeCheckpointCommit,
  "runtimeId" | "codecId" | "codecVersion" | "payloadKind"
>;

export function assertRuntimeCheckpointCompatible(
  adapter: RuntimeAdapter,
  checkpoint: RuntimeCheckpointDescriptor,
): void {
  if (
    checkpoint.runtimeId !== "legacy" &&
    checkpoint.runtimeId !== adapter.runtimeId
  ) {
    throw new Error(
      `checkpoint runtime ${checkpoint.runtimeId} is incompatible with ${adapter.runtimeId}`,
    );
  }
  const codec = adapter.checkpointCodecs.find(
    (candidate) =>
      candidate.codecId === checkpoint.codecId &&
      candidate.codecVersion === checkpoint.codecVersion &&
      candidate.payloadKind === checkpoint.payloadKind,
  );
  if (
    !codec ||
    (checkpoint.runtimeId === "legacy" && codec.codecId !== "json-v1")
  ) {
    throw new Error(
      `checkpoint codec ${checkpoint.codecId}@${checkpoint.codecVersion}/${checkpoint.payloadKind} is incompatible with ${adapter.runtimeId}`,
    );
  }
}

/**
 * One language runtime: how to talk to a process of it, and how execs and
 * checkpoints are encoded. The process itself comes from the payload, whose
 * environment is resolved before any adapter is constructed.
 */
export interface RuntimeAdapter {
  runtimeId: RuntimeId;
  displayName: string;
  checkpointCodecs: readonly RuntimeCheckpointCodec[];
  modelProfile: RuntimeModelProfile;
  createTransport(): RuntimeTransport;
  prepareExec(input: PrepareExecInput): PreparedExec;
  doctor: RuntimeDoctor;
}
