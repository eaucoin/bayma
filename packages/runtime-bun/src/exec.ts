import { writeFileSync } from "node:fs";
import type {
  PrepareExecInput,
  PreparedExec,
  RuntimeDoctor,
} from "@bayma/core";
import {
  assertDoctorExecResult,
  type RuntimeCheckpointCodec,
} from "@bayma/core";
import { buildMarkers, createPromptAwareEnvelopeCollector } from "@bayma/core";
import { createExecFileWorkspace } from "@bayma/core";
import { bunInspectionPrelude } from "./inspection.ts";

export const BUN_CHECKPOINT_CODEC = {
  codecId: "bun-jsc-structured-clone-v1",
  codecVersion: 1,
  payloadKind: "binary-sidecar",
} as const satisfies RuntimeCheckpointCodec;

function writeBunExecFile(input: PrepareExecInput): PreparedExec {
  const markers = buildMarkers();
  const workspace = createExecFileWorkspace(
    input.rootDir,
    input.sessionId,
    input.execId,
  );
  try {
    const execFile = workspace.file("x.ts");
    const checkpointManifestLiteral = JSON.stringify(
      input.checkpoint?.manifest ?? null,
    );
    const checkpointPayloadPathLiteral = JSON.stringify(
      input.checkpoint?.payloadAbsolutePath ?? null,
    );
    const checkpointOutputPath = workspace.file("checkpoint.bin");
    const source = [
      `const __baymaEventPrefix = ${JSON.stringify(markers.eventPrefix)};`,
      `const __baymaDurabilityMode = ${JSON.stringify(input.durabilityMode)};`,
      `const __baymaCheckpointManifest = ${checkpointManifestLiteral};`,
      `const __baymaCheckpointPayloadPath = ${checkpointPayloadPathLiteral};`,
      `const __baymaCheckpointOutputPath = ${JSON.stringify(checkpointOutputPath)};`,
      `const { serialize: __baymaSerialize, deserialize: __baymaDeserialize } = await import("bun:jsc");`,
      `const { readFileSync: __baymaReadFileSync, writeFileSync: __baymaWriteFileSync } = await import("node:fs");`,
      `const __baymaOriginalStdoutWrite = process.stdout.write.bind(process.stdout);`,
      `const __baymaOriginalStderrWrite = process.stderr.write.bind(process.stderr);`,
      `const __baymaTextDecoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };`,
      `const __baymaState = (globalThis.__bayma ??= {});`,
      `const __baymaLoadInitialCheckpoint = () => {`,
      `  if (__baymaDurabilityMode !== "checkpointed" || !__baymaCheckpointManifest) return null;`,
      `  if (__baymaCheckpointManifest.payloadKind === "binary-sidecar") {`,
      `    if (!__baymaCheckpointPayloadPath) throw new Error("checkpoint payload path is missing");`,
      `    return __baymaDeserialize(__baymaReadFileSync(__baymaCheckpointPayloadPath));`,
      `  }`,
      `  if (__baymaCheckpointManifest.payloadKind === "json-inline") {`,
      `    return __baymaCheckpointManifest.inlineJson ?? null;`,
      `  }`,
      `  throw new Error("unsupported Bun checkpoint payload kind " + __baymaCheckpointManifest.payloadKind);`,
      `};`,
      `if (__baymaDurabilityMode === "checkpointed" && !Object.prototype.hasOwnProperty.call(__baymaState, "checkpoint")) {`,
      `  __baymaState.checkpoint = __baymaLoadInitialCheckpoint();`,
      `}`,
      `Object.defineProperty(globalThis, "$checkpoint", {`,
      `  configurable: true,`,
      `  get() {`,
      `    return __baymaState.checkpoint;`,
      `  },`,
      `  set(value) {`,
      `    __baymaState.checkpoint = value;`,
      `  },`,
      `});`,
      ...bunInspectionPrelude(),
      `const __baymaEmit = (kind, payload = {}) => {`,
      `  const boundedPayload = typeof payload.text === "string" ? { ...payload, text: __baymaBoundText(payload.text) } : payload;`,
      `  __baymaOriginalStdoutWrite(__baymaEventPrefix + JSON.stringify({ kind, ...boundedPayload }) + "\\n");`,
      `};`,
      `const __baymaDecodeChunk = (kind, chunk) => {`,
      `  const decoder = __baymaTextDecoders[kind];`,
      `  if (typeof chunk === "string") return decoder.decode() + chunk;`,
      `  if (ArrayBuffer.isView(chunk)) {`,
      `    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);`,
      `    return decoder.decode(bytes, { stream: true });`,
      `  }`,
      `  throw new TypeError("process stream writes require a string or ArrayBuffer view");`,
      `};`,
      `const __baymaWrapWrite = (kind) => (...args) => {`,
      `  const [chunk] = args;`,
      `  const encodingOrCallback = args[1];`,
      `  const trailingCallback = args[2];`,
      `  if (encodingOrCallback !== undefined && typeof encodingOrCallback !== "string" && typeof encodingOrCallback !== "function") {`,
      `    throw new TypeError("process stream write encoding must be a string");`,
      `  }`,
      `  if (trailingCallback !== undefined && typeof trailingCallback !== "function") {`,
      `    throw new TypeError("process stream write callback must be a function");`,
      `  }`,
      `  const callback = typeof trailingCallback === "function" ? trailingCallback : typeof encodingOrCallback === "function" ? encodingOrCallback : undefined;`,
      `  const text = __baymaDecodeChunk(kind, chunk);`,
      `  if (text) __baymaEmit(kind, { text });`,
      `  if (callback) queueMicrotask(callback);`,
      `  return true;`,
      `};`,
      `const __baymaConsoleMethods = {`,
      `  log: console.log.bind(console),`,
      `  info: console.info.bind(console),`,
      `  debug: console.debug.bind(console),`,
      `  warn: console.warn.bind(console),`,
      `  error: console.error.bind(console),`,
      `};`,
      `const __baymaWrapConsole = (kind) => (...args) => {`,
      `  const rendered = args.map((value) => __baymaInspect(value, true)).join(" ");`,
      `  __baymaEmit(kind, { text: rendered + "\\n" });`,
      `};`,
      `process.stdout.write = __baymaWrapWrite("stdout");`,
      `process.stderr.write = __baymaWrapWrite("stderr");`,
      `console.log = __baymaWrapConsole("stdout");`,
      `console.info = __baymaWrapConsole("stdout");`,
      `console.debug = __baymaWrapConsole("stdout");`,
      `console.warn = __baymaWrapConsole("stderr");`,
      `console.error = __baymaWrapConsole("stderr");`,
      `try {`,
      `  const __baymaTranspiler = new Bun.Transpiler({ loader: "ts", replMode: true });`,
      `  const __baymaWrappedResult = await (0, eval)(__baymaTranspiler.transformSync(${JSON.stringify(input.code)}));`,
      `  const __baymaHasValue =`,
      `    __baymaWrappedResult !== null &&`,
      `    typeof __baymaWrappedResult === "object" &&`,
      `    Object.prototype.hasOwnProperty.call(__baymaWrappedResult, "value");`,
      `  const __baymaValue = __baymaHasValue ? __baymaWrappedResult.value : undefined;`,
      `  if (__baymaHasValue) {`,
      `    if (__baymaValue !== undefined) {`,
      `      globalThis._ = __baymaValue;`,
      `      __baymaEmit("result", { text: __baymaInspect(__baymaValue) });`,
      `    }`,
      `  }`,
      `} catch (__baymaError) {`,
      `  globalThis._error = __baymaError;`,
      `  const __baymaText = __baymaCaughtErrorText(__baymaError);`,
      `  __baymaEmit("error", { text: __baymaBoundText(__baymaText) });`,
      `} finally {`,
      `  if (__baymaDurabilityMode === "checkpointed") {`,
      `    try {`,
      `      const __baymaSerializedCheckpoint = __baymaSerialize(__baymaState.checkpoint ?? null);`,
      `      __baymaWriteFileSync(__baymaCheckpointOutputPath, Buffer.from(__baymaSerializedCheckpoint));`,
      `      __baymaEmit("checkpoint", { checkpoint: {`,
      `        runtimeId: "bun",`,
      `        codecId: ${JSON.stringify(BUN_CHECKPOINT_CODEC.codecId)},`,
      `        codecVersion: ${BUN_CHECKPOINT_CODEC.codecVersion},`,
      `        payloadKind: ${JSON.stringify(BUN_CHECKPOINT_CODEC.payloadKind)},`,
      `        payloadPath: __baymaCheckpointOutputPath,`,
      `        compatibility: { runtimeVersion: Bun.version, platform: process.platform, arch: process.arch },`,
      `      } });`,
      `    } catch (__baymaCheckpointError) {`,
      `      const __baymaCheckpointText = __baymaCaughtErrorText(__baymaCheckpointError);`,
      `      __baymaEmit("error", { text: __baymaBoundText(__baymaCheckpointText) });`,
      `    }`,
      `  }`,
      `  for (const __baymaKind of ["stdout", "stderr"]) {`,
      `    const __baymaTail = __baymaTextDecoders[__baymaKind].decode();`,
      `    if (__baymaTail) __baymaEmit(__baymaKind, { text: __baymaTail });`,
      `  }`,
      `  process.stdout.write = __baymaOriginalStdoutWrite;`,
      `  process.stderr.write = __baymaOriginalStderrWrite;`,
      `  console.log = __baymaConsoleMethods.log;`,
      `  console.info = __baymaConsoleMethods.info;`,
      `  console.debug = __baymaConsoleMethods.debug;`,
      `  console.warn = __baymaConsoleMethods.warn;`,
      `  console.error = __baymaConsoleMethods.error;`,
      `  __baymaEmit("done");`,
      `}`,
      `void 0;`,
      "",
    ].join("\n");

    writeFileSync(execFile, source, "utf8");

    return {
      submitText: `.load ${execFile}\n`,
      collector: createPromptAwareEnvelopeCollector(markers, [">", "❯", "..."]),
      dispose: workspace.dispose,
    };
  } catch (error) {
    workspace.dispose();
    throw error;
  }
}

export const bunDoctor: RuntimeDoctor = {
  probeCode: "40 + 2",
  successMessage: "ok: Bayma executed JavaScript in the Bun runtime",
  assertSuccess: (exec) => assertDoctorExecResult(exec, "42"),
};

export { writeBunExecFile };
