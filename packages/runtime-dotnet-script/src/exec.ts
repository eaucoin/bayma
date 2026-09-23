import { readFileSync, writeFileSync } from "node:fs";
import type {
  PrepareExecInput,
  PreparedExec,
  RuntimeDoctor,
} from "@bayma/core";
import { assertDoctorExecResult } from "@bayma/core";
import { buildMarkers, createPromptAwareEnvelopeCollector } from "@bayma/core";
import { createExecFileWorkspace } from "@bayma/core";
import { DOTNET_PROMPT } from "./transport.ts";

interface DotnetExecSpec {
  event_prefix: string;
  code: string;
  source_path: string;
  durability_mode: string;
  checkpoint_json: string | null;
  checkpoint_output_path: string;
}

function checkpointJson(input: PrepareExecInput): string | null {
  if (!input.checkpoint) return null;
  if (input.checkpoint.manifest.payloadKind === "json-inline") {
    return JSON.stringify(input.checkpoint.manifest.inlineJson ?? null);
  }
  if (
    input.checkpoint.manifest.payloadKind === "text-sidecar" &&
    input.checkpoint.payloadAbsolutePath
  ) {
    return readFileSync(input.checkpoint.payloadAbsolutePath, "utf8");
  }
  throw new Error(
    `dotnet-script does not support checkpoint payload kind ${input.checkpoint.manifest.payloadKind}`,
  );
}

function writeDotnetExecFile(input: PrepareExecInput): PreparedExec {
  const markers = buildMarkers();
  const workspace = createExecFileWorkspace(
    input.rootDir,
    input.sessionId,
    input.execId,
  );
  try {
    const sourcePath = workspace.file("submission.csx");
    const specPath = workspace.file("submission.json");
    const checkpointOutputPath = workspace.file("checkpoint.json");
    writeFileSync(sourcePath, input.code + "\n", "utf8");
    const spec: DotnetExecSpec = {
      event_prefix: markers.eventPrefix,
      code: input.code,
      source_path: sourcePath,
      durability_mode: input.durabilityMode,
      checkpoint_json: checkpointJson(input),
      checkpoint_output_path: checkpointOutputPath,
    };
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    return {
      submitText: `:exec ${specPath}\n`,
      collector: createPromptAwareEnvelopeCollector(markers, [DOTNET_PROMPT]),
      dispose: workspace.dispose,
    };
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}

export const dotnetScriptDoctor: RuntimeDoctor = {
  probeCode: "40 + 2",
  successMessage: "ok: Bayma executed C# in the dotnet-script runtime",
  assertSuccess: (exec) => assertDoctorExecResult(exec, "42"),
};

export { writeDotnetExecFile };
