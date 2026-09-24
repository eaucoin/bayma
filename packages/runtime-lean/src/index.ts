import { JSON_CHECKPOINT_CODEC, type RuntimeAdapter } from "@bayma/core";
import { leanDoctor, writeLeanExecFile } from "./exec.ts";
import { leanModelProfile } from "./profile.ts";
import { createLeanTransport, LEAN_CHECKPOINT_CODEC } from "./transport.ts";

export const leanAdapter: RuntimeAdapter = {
  runtimeId: "lean",
  displayName: "Lean",
  checkpointCodecs: [JSON_CHECKPOINT_CODEC, LEAN_CHECKPOINT_CODEC],
  modelProfile: leanModelProfile,
  createTransport: createLeanTransport,
  prepareExec: writeLeanExecFile,
  doctor: leanDoctor,
};

export { leanHostCommand } from "./transport.ts";
