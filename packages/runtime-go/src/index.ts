import { JSON_CHECKPOINT_CODEC, type RuntimeAdapter } from "@bayma/core";
import { goDoctor, writeGoExecFile } from "./exec.ts";
import { goModelProfile } from "./profile.ts";
import { createGoTransport } from "./transport.ts";

export const goAdapter: RuntimeAdapter = {
  runtimeId: "go",
  displayName: "Go",
  checkpointCodecs: [JSON_CHECKPOINT_CODEC],
  modelProfile: goModelProfile,
  createTransport: createGoTransport,
  prepareExec: writeGoExecFile,
  doctor: goDoctor,
  keepsOfEachCell: "each cell's plugin loaded, which Go never unloads",
};

export {
  createGoTransport,
  goHostCommand,
  goHostModules,
} from "./transport.ts";
