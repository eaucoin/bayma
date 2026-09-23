import { JSON_CHECKPOINT_CODEC, type RuntimeAdapter } from "@bayma/core";
import { dotnetScriptModelProfile } from "./profile.ts";
import {
  createDotnetScriptTransport,
  DOTNET_CHECKPOINT_CODEC,
  DOTNET_LEGACY_INLINE_CHECKPOINT_CODEC,
} from "./transport.ts";
import { dotnetScriptDoctor, writeDotnetExecFile } from "./exec.ts";

export const dotnetScriptAdapter: RuntimeAdapter = {
  runtimeId: "dotnet-script",
  displayName: "dotnet-script",
  checkpointCodecs: [
    JSON_CHECKPOINT_CODEC,
    DOTNET_LEGACY_INLINE_CHECKPOINT_CODEC,
    DOTNET_CHECKPOINT_CODEC,
  ],
  modelProfile: dotnetScriptModelProfile,
  createTransport: createDotnetScriptTransport,
  prepareExec: writeDotnetExecFile,
  doctor: dotnetScriptDoctor,
};

export { resolveDotnetScriptCacheRoot } from "./transport.ts";
export * from "./paths.ts";
