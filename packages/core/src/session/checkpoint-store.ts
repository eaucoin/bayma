import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  mkdirSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  assertSafePersistedId,
  createOpaqueId,
  SAFE_PERSISTED_ID_PATTERN,
} from "../ids.ts";

export type CheckpointPayloadKind =
  "json-inline" | "binary-sidecar" | "text-sidecar";

export const CHECKPOINT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_CHECKPOINT_PAYLOAD_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_IO_BUFFER_BYTES = 64 * 1024;

export interface CheckpointCompatibility {
  runtimeVersion?: string;
  languageVersion?: string;
  adapterVersion?: string;
  platform?: string;
  arch?: string;
}

export interface RuntimeCheckpointCommit {
  runtimeId: string;
  codecId: string;
  codecVersion: number;
  payloadKind: CheckpointPayloadKind;
  inlineJson?: unknown;
  payloadPath?: string;
  byteLength?: number;
  sha256?: string;
  compatibility?: CheckpointCompatibility;
}

export interface SessionCheckpoint {
  schemaVersion: typeof CHECKPOINT_MANIFEST_SCHEMA_VERSION;
  revision: string;
  updatedAtMs: number;
  runtimeId: string;
  codecId: string;
  codecVersion: number;
  payloadKind: CheckpointPayloadKind;
  payloadPath?: string;
  inlineJson?: unknown;
  byteLength: number;
  sha256: string;
  compatibility: CheckpointCompatibility;
  value?: unknown;
}

interface LegacySessionCheckpoint {
  revision: string;
  updatedAtMs: number;
  value: unknown;
}

export interface RuntimeCheckpointSnapshot {
  manifest: SessionCheckpoint;
  payloadAbsolutePath?: string;
}

export interface CheckpointReadResult {
  checkpoint: SessionCheckpoint | null;
  failure?: string;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function assertCheckpointSize(byteLength: number): void {
  if (byteLength > MAX_CHECKPOINT_PAYLOAD_BYTES) {
    throw new Error(
      `checkpoint payload exceeds ${MAX_CHECKPOINT_PAYLOAD_BYTES} bytes`,
    );
  }
}

function copyAndHashCheckpoint(
  sourcePath: string,
  destinationPath: string,
): { byteLength: number; sha256: string } {
  const source = openSync(sourcePath, "r");
  let destination: number | undefined;
  try {
    const sourceStat = fstatSync(source);
    if (!sourceStat.isFile()) {
      throw new Error("checkpoint sidecar source is not a regular file");
    }
    assertCheckpointSize(sourceStat.size);
    destination = openSync(destinationPath, "wx");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHECKPOINT_IO_BUFFER_BYTES);
    let byteLength = 0;
    while (true) {
      const bytesRead = readSync(source, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      assertCheckpointSize(byteLength);
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = writeSync(
          destination,
          buffer,
          written,
          bytesRead - written,
        );
        if (bytesWritten === 0) {
          throw new Error("checkpoint sidecar copy made no progress");
        }
        written += bytesWritten;
      }
    }
    return { byteLength, sha256: hash.digest("hex") };
  } finally {
    if (destination !== undefined) closeSync(destination);
    closeSync(source);
  }
}

function hashCheckpointFile(path: string): {
  byteLength: number;
  sha256: string;
} {
  const descriptor = openSync(path, "r");
  try {
    const file = fstatSync(descriptor);
    if (!file.isFile()) {
      throw new Error("checkpoint sidecar payload is not a regular file");
    }
    assertCheckpointSize(file.size);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHECKPOINT_IO_BUFFER_BYTES);
    let byteLength = 0;
    while (true) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      assertCheckpointSize(byteLength);
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { byteLength, sha256: hash.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function serializeCheckpointJson(value: unknown): string {
  const normalized = value ?? null;
  assertJsonValue(normalized, "$", new WeakSet<object>());
  return JSON.stringify(normalized);
}

function assertJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(
        `checkpoint JSON contains a non-canonical number at ${path}`,
      );
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`checkpoint JSON contains ${typeof value} at ${path}`);
  }
  if (ancestors.has(value)) {
    throw new Error(`checkpoint JSON contains a cycle at ${path}`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor) {
          throw new Error(`checkpoint JSON contains a sparse array at ${path}`);
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(
            `checkpoint JSON array has a non-data item at ${path}[${index}]`,
          );
        }
        assertJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
      }
      const extraKeys = Reflect.ownKeys(value).filter(
        (key) =>
          key !== "length" &&
          (typeof key !== "string" ||
            !/^(0|[1-9]\d*)$/.test(key) ||
            Number(key) >= value.length),
      );
      if (extraKeys.length > 0) {
        throw new Error(
          `checkpoint JSON array has extra properties at ${path}`,
        );
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`checkpoint JSON contains a non-plain object at ${path}`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== "string" ||
        !descriptor?.enumerable ||
        !("value" in descriptor)
      ) {
        throw new Error(`checkpoint JSON has a non-data property at ${path}`);
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function legacyCheckpoint(value: LegacySessionCheckpoint): SessionCheckpoint {
  const bytes = serializeCheckpointJson(value.value);
  return {
    schemaVersion: CHECKPOINT_MANIFEST_SCHEMA_VERSION,
    revision: value.revision,
    updatedAtMs: value.updatedAtMs,
    runtimeId: "legacy",
    codecId: "json-v1",
    codecVersion: 1,
    payloadKind: "json-inline",
    inlineJson: value.value,
    byteLength: Buffer.byteLength(bytes),
    sha256: sha256(bytes),
    compatibility: {},
    value: value.value,
  };
}

function parseLegacyCheckpoint(value: unknown): LegacySessionCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy checkpoint shape is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    !Object.hasOwn(record, "value") ||
    keys.length !== 3 ||
    !keys.every((key) => ["revision", "updatedAtMs", "value"].includes(key))
  ) {
    throw new Error("legacy checkpoint shape is invalid");
  }
  return record as unknown as LegacySessionCheckpoint;
}

export class CheckpointStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(this.checkpointsDir, { recursive: true });
  }

  get checkpointsDir(): string {
    return join(this.rootDir, "checkpoints");
  }

  checkpointPath(sessionId: string): string {
    return join(
      this.checkpointsDir,
      `${assertSafePersistedId(sessionId, "session ID")}.json`,
    );
  }

  checkpointDirectory(sessionId: string): string {
    return join(
      this.checkpointsDir,
      assertSafePersistedId(sessionId, "session ID"),
    );
  }

  manifestPath(sessionId: string): string {
    return join(this.checkpointDirectory(sessionId), "manifest.json");
  }

  payloadPath(sessionId: string, filename = "payload.bin"): string {
    return join(this.checkpointDirectory(sessionId), filename);
  }

  write(
    sessionId: string,
    checkpoint: SessionCheckpoint | LegacySessionCheckpoint,
    payloadSourcePath?: string,
  ): void {
    mkdirSync(this.checkpointsDir, { recursive: true });
    mkdirSync(this.checkpointDirectory(sessionId), { recursive: true });
    const normalized =
      "payloadKind" in checkpoint ? checkpoint : legacyCheckpoint(checkpoint);
    const manifest = { ...normalized };
    delete manifest.value;
    let newPayloadPath: string | undefined;
    let tempPayloadPath: string | undefined;
    let tempManifestPath: string | undefined;

    try {
      if (manifest.payloadKind === "json-inline") {
        manifest.inlineJson ??= null;
        const bytes = serializeCheckpointJson(manifest.inlineJson);
        manifest.byteLength = Buffer.byteLength(bytes);
        assertCheckpointSize(manifest.byteLength);
        manifest.sha256 = sha256(bytes);
        manifest.payloadPath = undefined;
      } else {
        if (!payloadSourcePath) {
          throw new Error(
            "sidecar checkpoint commit requires a payload source path",
          );
        }
        const extension =
          manifest.payloadKind === "text-sidecar" ? ".txt" : ".bin";
        const payloadName = `payload-${randomUUID()}${extension}`;
        const finalPayloadPath = this.payloadPath(sessionId, payloadName);
        tempPayloadPath = `${finalPayloadPath}.tmp`;
        const payload = copyAndHashCheckpoint(
          payloadSourcePath,
          tempPayloadPath,
        );
        manifest.byteLength = payload.byteLength;
        manifest.sha256 = payload.sha256;
        manifest.payloadPath = payloadName;
        renameSync(tempPayloadPath, finalPayloadPath);
        tempPayloadPath = undefined;
        newPayloadPath = finalPayloadPath;
      }

      this.validate(sessionId, manifest);
      const finalPath = this.manifestPath(sessionId);
      tempManifestPath = `${finalPath}.${randomUUID()}.tmp`;
      writeFileSync(
        tempManifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8",
      );
      renameSync(tempManifestPath, finalPath);
      tempManifestPath = undefined;
      newPayloadPath = undefined;
      this.retireObsoleteArtifacts(sessionId, manifest.payloadPath);
    } finally {
      if (tempPayloadPath) rmSync(tempPayloadPath, { force: true });
      if (tempManifestPath) rmSync(tempManifestPath, { force: true });
      if (newPayloadPath) rmSync(newPayloadPath, { force: true });
    }
  }

  private retireObsoleteArtifacts(
    sessionId: string,
    authoritativePayloadName?: string,
  ): void {
    // The manifest rename above is the commit point. Obsolete legacy files and
    // superseded payloads are garbage after that point, so an unlink failure
    // must not turn an already-authoritative commit into a reported failure.
    const removeFileBestEffort = (path: string): void => {
      try {
        rmSync(path, { force: true });
      } catch {
        return;
      }
    };
    removeFileBestEffort(this.checkpointPath(sessionId));
    let filenames: string[];
    try {
      filenames = readdirSync(this.checkpointDirectory(sessionId));
    } catch {
      return;
    }
    for (const filename of filenames) {
      if (
        filename.startsWith("payload-") &&
        filename !== authoritativePayloadName
      ) {
        removeFileBestEffort(this.payloadPath(sessionId, filename));
      }
    }
  }

  writeCommit(
    sessionId: string,
    commit: RuntimeCheckpointCommit,
  ): SessionCheckpoint {
    const existing = this.inspect(sessionId);
    if (existing.failure) {
      throw new Error(existing.failure);
    }
    const revision = createOpaqueId("ckpt");
    const updatedAtMs = Math.max(
      Date.now(),
      existing.checkpoint?.updatedAtMs ?? 0,
    );
    const manifest: SessionCheckpoint = {
      schemaVersion: CHECKPOINT_MANIFEST_SCHEMA_VERSION,
      revision,
      updatedAtMs,
      runtimeId: commit.runtimeId,
      codecId: commit.codecId,
      codecVersion: commit.codecVersion,
      payloadKind: commit.payloadKind,
      payloadPath: commit.payloadPath
        ? basename(commit.payloadPath)
        : undefined,
      inlineJson: commit.inlineJson,
      byteLength: commit.byteLength ?? 0,
      sha256: commit.sha256 ?? "",
      compatibility: commit.compatibility ?? {},
      value: commit.inlineJson,
    };
    this.write(sessionId, manifest, commit.payloadPath);
    const persisted = this.inspect(sessionId);
    if (!persisted.checkpoint) {
      throw new Error(
        persisted.failure ?? "checkpoint disappeared after it was committed",
      );
    }
    return persisted.checkpoint;
  }

  read(sessionId: string): SessionCheckpoint | null {
    return this.inspect(sessionId).checkpoint;
  }

  inspect(sessionId: string): CheckpointReadResult {
    const failures: string[] = [];
    const manifestPath = this.manifestPath(sessionId);
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
          string,
          unknown
        >;
        const manifest = {
          ...(parsed.schemaVersion === undefined
            ? { schemaVersion: CHECKPOINT_MANIFEST_SCHEMA_VERSION }
            : {}),
          ...parsed,
        } as SessionCheckpoint;
        this.validate(sessionId, manifest);
        if (manifest.payloadKind === "json-inline") {
          manifest.value = manifest.inlineJson;
        }
        return { checkpoint: manifest };
      } catch (error) {
        return {
          checkpoint: null,
          failure: `checkpoint is unreadable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }

    const legacyPath = this.checkpointPath(sessionId);
    if (existsSync(legacyPath)) {
      try {
        const legacy = parseLegacyCheckpoint(
          JSON.parse(readFileSync(legacyPath, "utf8")),
        );
        const checkpoint = legacyCheckpoint(legacy);
        const persistedCheckpoint = { ...checkpoint };
        delete persistedCheckpoint.value;
        this.validate(sessionId, persistedCheckpoint);
        return { checkpoint };
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      checkpoint: null,
      ...(failures.length > 0
        ? { failure: `checkpoint is unreadable: ${failures.join("; ")}` }
        : {}),
    };
  }

  snapshot(sessionId: string): RuntimeCheckpointSnapshot | null {
    const inspected = this.inspect(sessionId);
    if (inspected.failure) {
      throw new Error(inspected.failure);
    }
    const manifest = inspected.checkpoint;
    if (!manifest) return null;
    return {
      manifest,
      payloadAbsolutePath:
        manifest.payloadKind === "json-inline" || !manifest.payloadPath
          ? undefined
          : this.payloadPath(sessionId, manifest.payloadPath),
    };
  }

  validate(sessionId: string, checkpoint: SessionCheckpoint): void {
    const allowedKeys = new Set([
      "revision",
      "schemaVersion",
      "updatedAtMs",
      "runtimeId",
      "codecId",
      "codecVersion",
      "payloadKind",
      "payloadPath",
      "inlineJson",
      "byteLength",
      "sha256",
      "compatibility",
    ]);
    if (
      !Object.keys(checkpoint).every((key) => allowedKeys.has(key)) ||
      checkpoint.schemaVersion !== CHECKPOINT_MANIFEST_SCHEMA_VERSION ||
      typeof checkpoint.runtimeId !== "string" ||
      checkpoint.runtimeId.length === 0 ||
      typeof checkpoint.codecId !== "string" ||
      checkpoint.codecId.length === 0 ||
      !Number.isInteger(checkpoint.codecVersion) ||
      checkpoint.codecVersion < 1 ||
      !Number.isInteger(checkpoint.byteLength) ||
      checkpoint.byteLength < 0 ||
      checkpoint.byteLength > MAX_CHECKPOINT_PAYLOAD_BYTES ||
      !/^[0-9a-f]{64}$/i.test(checkpoint.sha256) ||
      !checkpoint.compatibility ||
      typeof checkpoint.compatibility !== "object" ||
      Array.isArray(checkpoint.compatibility) ||
      !Object.entries(checkpoint.compatibility).every(
        ([key, value]) =>
          [
            "runtimeVersion",
            "languageVersion",
            "adapterVersion",
            "platform",
            "arch",
          ].includes(key) &&
          (value === undefined || typeof value === "string"),
      ) ||
      typeof checkpoint.revision !== "string" ||
      !SAFE_PERSISTED_ID_PATTERN.test(checkpoint.revision) ||
      !Number.isFinite(checkpoint.updatedAtMs) ||
      checkpoint.updatedAtMs < 0
    ) {
      throw new Error("checkpoint manifest shape is invalid");
    }
    if (checkpoint.payloadKind === "json-inline") {
      if (!Object.hasOwn(checkpoint, "inlineJson")) {
        throw new Error("inline checkpoint JSON payload is missing");
      }
      if (checkpoint.payloadPath !== undefined) {
        throw new Error("inline checkpoint may not name a sidecar payload");
      }
      const bytes = serializeCheckpointJson(checkpoint.inlineJson);
      const byteLength = Buffer.byteLength(bytes);
      assertCheckpointSize(byteLength);
      const digest = sha256(bytes);
      if (
        checkpoint.byteLength !== byteLength ||
        checkpoint.sha256 !== digest
      ) {
        throw new Error("checkpoint inline JSON checksum mismatch");
      }
      return;
    }
    if (
      checkpoint.payloadKind !== "binary-sidecar" &&
      checkpoint.payloadKind !== "text-sidecar"
    ) {
      throw new Error("checkpoint payload kind is invalid");
    }
    if (!checkpoint.payloadPath) {
      throw new Error("checkpoint sidecar payload path is missing");
    }
    if (checkpoint.inlineJson !== undefined) {
      throw new Error("sidecar checkpoint may not contain inline JSON");
    }
    if (basename(checkpoint.payloadPath) !== checkpoint.payloadPath) {
      throw new Error("checkpoint sidecar payload path must be a filename");
    }
    const absolutePath = this.payloadPath(sessionId, checkpoint.payloadPath);
    if (!existsSync(absolutePath)) {
      throw new Error("checkpoint sidecar payload is missing");
    }
    const payload = hashCheckpointFile(absolutePath);
    if (
      checkpoint.byteLength !== payload.byteLength ||
      checkpoint.sha256 !== payload.sha256
    ) {
      throw new Error("checkpoint sidecar checksum mismatch");
    }
  }

  remove(sessionId: string): void {
    rmSync(this.checkpointPath(sessionId), { force: true });
    rmSync(this.checkpointDirectory(sessionId), {
      recursive: true,
      force: true,
    });
  }
}
