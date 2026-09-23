import { JSON_CHECKPOINT_CODEC, type RuntimeAdapter } from "@bayma/core";
import { pythonModelProfile } from "./profile.ts";
import { createPythonTransport, PYTHON_CHECKPOINT_CODEC } from "./transport.ts";
import { pythonDoctor, writePythonExecFile } from "./exec.ts";

export const pythonAdapter: RuntimeAdapter = {
  runtimeId: "python",
  displayName: "Python",
  checkpointCodecs: [JSON_CHECKPOINT_CODEC, PYTHON_CHECKPOINT_CODEC],
  modelProfile: pythonModelProfile,
  createTransport: createPythonTransport,
  prepareExec: writePythonExecFile,
  doctor: pythonDoctor,
};
