// Public surface of @bayma/core.
//
// Runtime adapters, the server entrypoints, and the test suite import from
// here only. Modules not re-exported (mcp/tools, mcp/resources, mcp/shutdown)
// are implementation details of the MCP surface.

// Engine: one adapter, one state directory, one session manager.
export { createEngine, type Engine, type EngineConfig } from "./engine.ts";
export { runCli, parseCliOptions } from "./cli.ts";
export {
  runDoctor,
  doctorSuccessOutput,
  assertDoctorProcessResult,
  DOCTOR_RESULT_SCHEMA_VERSION,
  type DoctorOptions,
} from "./doctor.ts";
export { BAYMA_VERSION } from "./version.ts";
export { aggregateFailure, describeFailure, failureDetail } from "./errors.ts";
export {
  createOpaqueId,
  assertSafePersistedId,
  SAFE_PERSISTED_ID_PATTERN,
} from "./ids.ts";

// Sessions: model, manager, persistence.
export * from "./session/model.ts";
export * from "./session/exec-types.ts";
export * from "./session/events.ts";
export {
  SessionManager,
  validateSessionManagerOptions,
  type SessionCreatePolicy,
  type SessionManagerOptions,
  type SessionRecord,
} from "./session/session-manager.ts";
export * from "./session/retention-policy.ts";
export * from "./session/catalog-store.ts";
export * from "./session/checkpoint-store.ts";
export * from "./session/exec-history-store.ts";
export * from "./session/exec-recovery.ts";
export { EventLog } from "./session/event-log.ts";
export {
  ExecOutputCapture,
  appendExecMessage,
} from "./session/exec-capture.ts";

// Runtimes: the adapter contract and the machinery adapters build on.
export * from "./runtime/id.ts";
export * from "./runtime/profile.ts";
export * from "./runtime/registry.ts";
export * from "./runtime/platform.ts";
export * from "./runtime/payload.ts";
export * from "./runtime/toolbelt.ts";
export * from "./runtime/payload-environment.ts";
export * from "./runtime/adapter.ts";
export * from "./runtime/transport.ts";
export * from "./runtime/process-transport.ts";
export * from "./runtime/exec-files.ts";
export * from "./runtime/exec-markers.ts";
export * from "./runtime/output-capture.ts";
export * from "./runtime/asset.ts";
export * from "./runtime/state-directory-lease.ts";
export * from "./paths.ts";

// MCP: serving, snapshots, resource URIs.
export { serveMcpStdio, type McpStdioConfig } from "./mcp/stdio.ts";
export { serveMcpHttp, type McpHttpConfig } from "./mcp/http.ts";
export {
  createMcpApplication,
  type McpApplication,
} from "./mcp/application.ts";
export { SubscribedResourceUpdatePublisher } from "./mcp/events.ts";
export { createModelSurface, type ModelSurface } from "./mcp/model-surface.ts";
export * from "./mcp/exec-snapshot.ts";
export * from "./mcp/truncate.ts";
export * from "./mcp/uris.ts";
