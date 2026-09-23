import { JSON_CHECKPOINT_CODEC, type RuntimeAdapter } from "@bayma/core";
import { rustDoctor, writeRustExecFile } from "./exec.ts";
import { rustModelProfile } from "./profile.ts";
import { createRustTransport, RUST_CHECKPOINT_CODEC } from "./transport.ts";

export const rustAdapter: RuntimeAdapter = {
  runtimeId: "rust",
  displayName: "Rust",
  checkpointCodecs: [JSON_CHECKPOINT_CODEC, RUST_CHECKPOINT_CODEC],
  modelProfile: rustModelProfile,
  createTransport: createRustTransport,
  prepareExec: writeRustExecFile,
  doctor: rustDoctor,
};

export { createRustTransport } from "./transport.ts";
