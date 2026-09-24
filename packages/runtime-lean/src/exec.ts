import { writeFileSync } from "node:fs";
import type {
  PrepareExecInput,
  PreparedExec,
  RuntimeDoctor,
} from "@bayma/core";
import {
  assertDoctorExecResult,
  buildMarkers,
  createExecFileWorkspace,
  createPromptAwareEnvelopeCollector,
} from "@bayma/core";
import { LEAN_PROMPT } from "./transport.ts";

interface LeanExecSpec {
  schema_version: 1;
  event_prefix: string;
  code: string;
  durability_mode: string;
  /** The checkpoint a host starting on a checkpointed session restores. */
  restore_path: string | null;
  checkpoint_output_path: string;
}

/** A session's environment checkpoint; a `json-v1` one holds nothing to restore. */
function restorePath(input: PrepareExecInput): string | null {
  if (!input.checkpoint) return null;
  switch (input.checkpoint.manifest.payloadKind) {
    case "binary-sidecar":
      return input.checkpoint.payloadAbsolutePath ?? null;
    case "json-inline":
      return null;
    default:
      throw new Error(
        `Lean does not support checkpoint payload kind ${input.checkpoint.manifest.payloadKind}`,
      );
  }
}

export function writeLeanExecFile(input: PrepareExecInput): PreparedExec {
  const markers = buildMarkers();
  const workspace = createExecFileWorkspace(
    input.rootDir,
    input.sessionId,
    input.execId,
  );
  try {
    const specPath = workspace.file("submission.json");
    const spec: LeanExecSpec = {
      schema_version: 1,
      event_prefix: markers.eventPrefix,
      code: input.code,
      durability_mode: input.durabilityMode,
      restore_path: restorePath(input),
      checkpoint_output_path: workspace.file("checkpoint.bin"),
    };
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    return {
      submitText: `:exec ${specPath}\n`,
      collector: createPromptAwareEnvelopeCollector(markers, [LEAN_PROMPT]),
      dispose: workspace.dispose,
    };
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}

export const leanDoctor: RuntimeDoctor = {
  probeCode: "#eval 40 + 2",
  successMessage: "ok: Bayma executed Lean in the Lean runtime",
  assertSuccess: (exec) => assertDoctorExecResult(exec, "42"),
};
