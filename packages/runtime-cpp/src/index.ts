import { JSON_CHECKPOINT_CODEC, type RuntimeAdapter } from "@bayma/core";
import { cppDoctor, writeCppExecFile } from "./exec.ts";
import { cModelProfile, cppModelProfile } from "./profile.ts";
import { createCppTransport } from "./transport.ts";

// C and C++ share one host, bayma-cpp-host, which embeds Clang's incremental
// Interpreter; each runtime runs it in its own language.

export const cAdapter: RuntimeAdapter = {
  runtimeId: "c",
  displayName: "C",
  checkpointCodecs: [JSON_CHECKPOINT_CODEC],
  modelProfile: cModelProfile,
  createTransport: () => createCppTransport("c"),
  prepareExec: writeCppExecFile,
  doctor: cppDoctor("C"),
};

export const cppAdapter: RuntimeAdapter = {
  runtimeId: "cpp",
  displayName: "C++",
  checkpointCodecs: [JSON_CHECKPOINT_CODEC],
  modelProfile: cppModelProfile,
  createTransport: () => createCppTransport("c++"),
  prepareExec: writeCppExecFile,
  doctor: cppDoctor("C++"),
};
