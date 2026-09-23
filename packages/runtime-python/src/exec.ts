import { writeFileSync } from "node:fs";
import type {
  PrepareExecInput,
  PreparedExec,
  RuntimeDoctor,
} from "@bayma/core";
import { assertDoctorExecResult } from "@bayma/core";
import { buildMarkers, createPromptAwareEnvelopeCollector } from "@bayma/core";
import { createExecFileWorkspace } from "@bayma/core";
import { PYTHON_PROMPT } from "./transport.ts";

interface PythonExecSpec {
  event_prefix: string;
  code: string;
  source_path: string;
  durability_mode: string;
  checkpoint: {
    codec_id: string;
    payload_kind: string;
    inline_json?: unknown;
    payload_path?: string;
  } | null;
  checkpoint_output_path: string;
}

function writePythonExecFile(input: PrepareExecInput): PreparedExec {
  const markers = buildMarkers();
  const workspace = createExecFileWorkspace(
    input.rootDir,
    input.sessionId,
    input.execId,
  );
  try {
    const sourcePath = workspace.file("submission.py");
    const specPath = workspace.file("submission.json");
    const checkpointOutputPath = workspace.file("checkpoint.pkl");
    writeFileSync(sourcePath, input.code + "\n", "utf8");
    const spec: PythonExecSpec = {
      event_prefix: markers.eventPrefix,
      code: input.code,
      source_path: sourcePath,
      durability_mode: input.durabilityMode,
      checkpoint: input.checkpoint
        ? {
            codec_id: input.checkpoint.manifest.codecId,
            payload_kind: input.checkpoint.manifest.payloadKind,
            inline_json: input.checkpoint.manifest.inlineJson,
            payload_path: input.checkpoint.payloadAbsolutePath,
          }
        : null,
      checkpoint_output_path: checkpointOutputPath,
    };
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    return {
      submitText: `:exec ${specPath}\n`,
      collector: createPromptAwareEnvelopeCollector(markers, [PYTHON_PROMPT]),
      dispose: workspace.dispose,
    };
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}

export const pythonDoctor: RuntimeDoctor = {
  probeCode: "40 + 2",
  successMessage: "ok: Bayma executed Python in the Python runtime",
  assertSuccess: (exec) => assertDoctorExecResult(exec, "42"),
};

export { writePythonExecFile };
