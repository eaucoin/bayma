import { JSON_CHECKPOINT_CODEC, type RuntimeAdapter } from "@bayma/core";
import { bunModelProfile } from "./profile.ts";
import { createBunTransport } from "./transport.ts";
import { BUN_CHECKPOINT_CODEC, bunDoctor, writeBunExecFile } from "./exec.ts";

export const bunAdapter: RuntimeAdapter = {
  runtimeId: "bun",
  displayName: "Bun",
  checkpointCodecs: [JSON_CHECKPOINT_CODEC, BUN_CHECKPOINT_CODEC],
  modelProfile: bunModelProfile,
  createTransport: createBunTransport,
  prepareExec: writeBunExecFile,
  doctor: bunDoctor,
};

export { createBunTransport } from "./transport.ts";
export { BUN_INSPECTION_POLICY } from "./inspection.ts";
