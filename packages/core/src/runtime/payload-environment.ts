import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { RUNTIME_IDS, type RuntimeId } from "./id.ts";
import type { PlatformId } from "./platform.ts";

/**
 * The payload manifest and the environment it resolves to. Every runtime is
 * run from the payload: the resolver drops the host's own toolchain
 * redirects, so a machine cannot point a bundled runtime somewhere else.
 */

export const PAYLOAD_MANIFEST = "payload.json";

export interface PayloadRuntime {
  root: string;
  env: Record<string, string>;
  envPaths: Record<string, string>;
  pathEnvPrepend: Record<string, string[]>;
  pins: Record<string, string>;
}

export interface PayloadManifest {
  schemaVersion: number;
  version: string;
  platform: PlatformId;
  runtimes: Record<RuntimeId, PayloadRuntime>;
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Every variable each runtime's transport needs the payload to supply. */
const REQUIRED_ENV_PATHS: Record<RuntimeId, readonly string[]> = {
  bun: ["BAYMA_BUN_BIN"],
  python: ["BAYMA_PYTHON_BIN"],
  "dotnet-script": [
    "DOTNET_ROOT",
    "BAYMA_DOTNET_ROOT",
    "BAYMA_DOTNET_SCRIPT_BIN",
    "BAYMA_DOTNET_SCRIPT_LIB_DIR",
  ],
  rust: [
    "BAYMA_RUST_HOST_BIN",
    "BAYMA_RUSTC_BIN",
    "BAYMA_CARGO_BIN",
    "BAYMA_RUST_SUPPORT_DIR",
    "BAYMA_RUST_CARGO_SEED_DIR",
  ],
  c: ["BAYMA_C_HOST_BIN"],
  cpp: ["BAYMA_CPP_HOST_BIN"],
};

/** Host variables that would redirect a runtime away from its payload. */
const HOST_RUNTIME_REDIRECTS = new Set([
  "BUN_INSTALL",
  "BUN_INSTALL_BIN",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
  "CARGO_BUILD_RUSTDOC",
  "CARGO_BUILD_RUSTDOCFLAGS",
  "CARGO_BUILD_RUSTFLAGS",
  "CARGO_BUILD_TARGET",
  "CARGO_BUILD_TARGET_DIR",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_HOME",
  "CARGO_TARGET_DIR",
  "DOTNET_MULTILEVEL_LOOKUP",
  "DOTNET_ROOT",
  "DOTNET_ROOT_X64",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUSTC",
  "RUSTC_BOOTSTRAP",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTC_WRAPPER",
  "RUSTDOC",
  "RUSTDOCFLAGS",
  "RUSTFLAGS",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "RUST_SRC_PATH",
  "VIRTUAL_ENV",
]);

function isHostRuntimeRedirect(name: string): boolean {
  return (
    HOST_RUNTIME_REDIRECTS.has(name) ||
    (name.startsWith("BAYMA_") && name !== "BAYMA_PAYLOAD_DIR") ||
    /^CARGO_TARGET_.+_(?:LINKER|RUNNER|RUSTFLAGS)$/.test(name)
  );
}

function fail(message: string): never {
  throw new Error(`invalid bayma payload: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapesRoot(relation: string): boolean {
  return (
    relation === ".." || relation.startsWith(`..${"/"}`) || isAbsolute(relation)
  );
}

/** Resolve a manifest path inside the payload, refusing anything that escapes. */
function resolvePayloadPath(
  payloadRoot: string,
  runtimeRoot: string,
  relativePath: string,
  label: string,
): string {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath)
  ) {
    fail(`${label} must be one nonempty relative payload path`);
  }
  // Checked before joining, because joining would collapse the escape away.
  if (relativePath.split("/").includes(".."))
    fail(`${label} escapes the payload root`);
  const lexicalPath = resolve(payloadRoot, runtimeRoot, relativePath);
  if (escapesRoot(relative(payloadRoot, lexicalPath)))
    fail(`${label} escapes the payload root`);
  if (!existsSync(lexicalPath)) fail(`${label} does not exist in the payload`);
  const physicalPath = realpathSync(lexicalPath);
  if (escapesRoot(relative(payloadRoot, physicalPath)))
    fail(`${label} resolves outside the payload root`);
  return physicalPath;
}

function parseStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${label} must be an object`);
  for (const [name, field] of Object.entries(value)) {
    if (!ENVIRONMENT_NAME.test(name) || typeof field !== "string")
      fail(`${label}.${name} must be a string environment value`);
  }
  return value as Record<string, string>;
}

function parsePathListRecord(
  value: unknown,
  label: string,
): Record<string, string[]> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${label} must be an object`);
  for (const [name, field] of Object.entries(value)) {
    if (
      !ENVIRONMENT_NAME.test(name) ||
      !Array.isArray(field) ||
      field.length === 0 ||
      field.some((entry) => typeof entry !== "string" || entry.length === 0) ||
      new Set(field).size !== field.length
    ) {
      fail(`${label}.${name} must be a nonempty list of unique payload paths`);
    }
  }
  return value as Record<string, string[]>;
}

/** Pins record what produced the payload; they name archives, not variables. */
function parsePins(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${label} must be an object`);
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== "string") fail(`${label}.${name} must be a string`);
  }
  return value as Record<string, string>;
}

function parseRuntime(runtimeId: RuntimeId, value: unknown): PayloadRuntime {
  if (!isRecord(value) || typeof value.root !== "string" || !value.root)
    fail(`${runtimeId} must name its root directory`);
  const env = parseStringRecord(value.env, `${runtimeId}.env`);
  const envPaths = parseStringRecord(value.envPaths, `${runtimeId}.envPaths`);
  const pathEnvPrepend = parsePathListRecord(
    value.pathEnvPrepend,
    `${runtimeId}.pathEnvPrepend`,
  );
  const names = [
    ...Object.keys(env),
    ...Object.keys(envPaths),
    ...Object.keys(pathEnvPrepend),
  ];
  if (new Set(names).size !== names.length)
    fail(`${runtimeId} assigns one environment variable more than once`);
  for (const required of REQUIRED_ENV_PATHS[runtimeId]) {
    if (!(required in envPaths))
      fail(`${runtimeId}.envPaths omits ${required}`);
  }
  if (!pathEnvPrepend.PATH) fail(`${runtimeId}.pathEnvPrepend omits PATH`);
  return {
    root: value.root,
    env,
    envPaths,
    pathEnvPrepend,
    pins: parsePins(value.pins, `${runtimeId}.pins`),
  };
}

export function readPayloadManifest(payloadRoot: string): PayloadManifest {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileSync(join(payloadRoot, PAYLOAD_MANIFEST), "utf8"),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(value) || !isRecord(value.runtimes))
    fail("manifest must describe its runtimes");
  const runtimes = value.runtimes;
  if (
    Object.keys(runtimes).length !== RUNTIME_IDS.length ||
    !RUNTIME_IDS.every((runtimeId) => Object.hasOwn(runtimes, runtimeId))
  ) {
    fail(`manifest must contain exactly ${RUNTIME_IDS.join(", ")}`);
  }
  return {
    schemaVersion: Number(value.schemaVersion),
    version: String(value.version),
    platform: value.platform as PlatformId,
    runtimes: Object.fromEntries(
      RUNTIME_IDS.map((runtimeId) => [
        runtimeId,
        parseRuntime(runtimeId, runtimes[runtimeId]),
      ]),
    ) as Record<RuntimeId, PayloadRuntime>,
  };
}

function assertDisjointAuthorities(
  runtimes: Record<RuntimeId, PayloadRuntime>,
): void {
  const exact = new Map<string, RuntimeId>();
  const prepend = new Map<string, RuntimeId>();
  for (const runtimeId of RUNTIME_IDS) {
    const runtime = runtimes[runtimeId];
    for (const name of [
      ...Object.keys(runtime.env),
      ...Object.keys(runtime.envPaths),
    ]) {
      if (exact.has(name))
        fail(`${name} is assigned by both ${exact.get(name)} and ${runtimeId}`);
      exact.set(name, runtimeId);
    }
    for (const name of Object.keys(runtime.pathEnvPrepend))
      prepend.set(name, runtimeId);
  }
  for (const [name, runtimeId] of exact) {
    if (prepend.has(name))
      fail(
        `${name} is assigned by ${runtimeId} and prepended by ${prepend.get(name)}`,
      );
  }
}

/** The environment every runtime in `payloadRoot` runs with. */
export function resolvePayloadEnvironment(
  payloadRoot: string,
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const root = realpathSync(resolve(payloadRoot));
  const manifest = readPayloadManifest(root);
  assertDisjointAuthorities(manifest.runtimes);
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !isHostRuntimeRedirect(entry[0]),
    ),
  );
  const prepends = new Map<string, string[]>();
  for (const runtimeId of RUNTIME_IDS) {
    const runtime = manifest.runtimes[runtimeId];
    Object.assign(env, runtime.env);
    for (const [name, relativePath] of Object.entries(runtime.envPaths)) {
      env[name] = resolvePayloadPath(
        root,
        runtime.root,
        relativePath,
        `${runtimeId}.envPaths.${name}`,
      );
    }
    for (const [name, entries] of Object.entries(runtime.pathEnvPrepend)) {
      const resolved = entries.map((entry, index) =>
        resolvePayloadPath(
          root,
          runtime.root,
          entry,
          `${runtimeId}.pathEnvPrepend.${name}[${index}]`,
        ),
      );
      prepends.set(name, [...(prepends.get(name) ?? []), ...resolved]);
    }
  }
  // Payload directories precede the host's own, in manifest order.
  for (const [name, entries] of prepends) {
    const existing = (env[name] ?? "").split(delimiter).filter(Boolean);
    env[name] = [...new Set([...entries, ...existing])].join(delimiter);
  }
  return env;
}

/** Put the payload's environment into this process, for the adapters to read. */
export function applyPayloadEnvironment(payloadRoot: string): void {
  const resolved = resolvePayloadEnvironment(payloadRoot);
  for (const name of Object.keys(process.env)) {
    if (!(name in resolved)) delete process.env[name];
  }
  Object.assign(process.env, resolved);
}
