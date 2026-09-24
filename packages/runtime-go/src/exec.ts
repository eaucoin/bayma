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
import { GO_PROMPT } from "./transport.ts";

interface GoExecSpec {
  schema_version: 1;
  event_prefix: string;
  code: string;
  durability_mode: string;
  /** The session's checkpoint, as JSON text. */
  checkpoint_json: string | null;
}

function checkpointJson(input: PrepareExecInput): string | null {
  if (!input.checkpoint) return null;
  if (input.checkpoint.manifest.payloadKind !== "json-inline") {
    throw new Error(
      `Go does not support checkpoint payload kind ${input.checkpoint.manifest.payloadKind}`,
    );
  }
  return JSON.stringify(input.checkpoint.manifest.inlineJson ?? null);
}

export function writeGoExecFile(input: PrepareExecInput): PreparedExec {
  const markers = buildMarkers();
  const workspace = createExecFileWorkspace(
    input.rootDir,
    input.sessionId,
    input.execId,
  );
  try {
    const specPath = workspace.file("submission.json");
    const spec: GoExecSpec = {
      schema_version: 1,
      event_prefix: markers.eventPrefix,
      code: input.code,
      durability_mode: input.durabilityMode,
      checkpoint_json: checkpointJson(input),
    };
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    return {
      submitText: `:exec ${specPath}\n`,
      collector: createPromptAwareEnvelopeCollector(markers, [GO_PROMPT]),
      dispose: workspace.dispose,
    };
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}

export const goDoctor: RuntimeDoctor = {
  probeCode: "40 + 2",
  successMessage: "ok: Bayma executed Go in the Go runtime",
  assertSuccess: (exec) => assertDoctorExecResult(exec, "42"),
};
