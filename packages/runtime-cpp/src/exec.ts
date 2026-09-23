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
import { CPP_PROMPT } from "./transport.ts";

interface CppExecSpec {
  schema_version: 1;
  event_prefix: string;
  code: string;
  durability_mode: string;
  /** The session's checkpoint as JSON text, for a host starting on it. */
  checkpoint_json: string | null;
}

function checkpointJson(input: PrepareExecInput): string | null {
  if (!input.checkpoint) return null;
  if (input.checkpoint.manifest.payloadKind !== "json-inline") {
    throw new Error(
      `C and C++ do not support checkpoint payload kind ${input.checkpoint.manifest.payloadKind}`,
    );
  }
  return JSON.stringify(input.checkpoint.manifest.inlineJson ?? null);
}

export function writeCppExecFile(input: PrepareExecInput): PreparedExec {
  const markers = buildMarkers();
  const workspace = createExecFileWorkspace(
    input.rootDir,
    input.sessionId,
    input.execId,
  );
  try {
    const specPath = workspace.file("submission.json");
    const spec: CppExecSpec = {
      schema_version: 1,
      event_prefix: markers.eventPrefix,
      code: input.code,
      durability_mode: input.durabilityMode,
      checkpoint_json: checkpointJson(input),
    };
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    return {
      submitText: `:exec ${specPath}\n`,
      collector: createPromptAwareEnvelopeCollector(markers, [CPP_PROMPT]),
      dispose: workspace.dispose,
    };
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}

export function cppDoctor(displayName: string): RuntimeDoctor {
  return {
    probeCode: "40 + 2",
    successMessage: `ok: Bayma executed ${displayName} in the ${displayName} runtime`,
    assertSuccess: (exec) => assertDoctorExecResult(exec, "42"),
  };
}
