import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod";
import { assertSafePersistedId, SAFE_PERSISTED_ID_PATTERN } from "../ids.ts";
import { RUNTIME_IDS, type RuntimeId } from "../runtime/id.ts";
import {
  DURABILITY_MODES,
  SESSION_STATUSES,
  type DurabilityMode,
  type SessionStatus,
} from "./model.ts";

export interface SessionCatalogEntry {
  schemaVersion: typeof SESSION_CATALOG_SCHEMA_VERSION;
  sessionId: string;
  runtimeId: RuntimeId;
  title: string;
  cwd: string;
  status: SessionStatus;
  durabilityMode: DurabilityMode;
  bootstrapCode?: string;
  checkpointRevision?: string;
  checkpointUpdatedAtMs?: number;
  runtimeGeneration: number;
  quarantineReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
  closed: boolean;
  cols: number;
  rows: number;
}

export const SESSION_CATALOG_SCHEMA_VERSION = 2 as const;
export type SessionCatalogWrite = Omit<SessionCatalogEntry, "schemaVersion"> & {
  schemaVersion?: typeof SESSION_CATALOG_SCHEMA_VERSION;
};

const SessionCatalogEntrySchema: z.ZodType<SessionCatalogEntry> = z
  .strictObject({
    schemaVersion: z.literal(SESSION_CATALOG_SCHEMA_VERSION),
    sessionId: z.string().regex(SAFE_PERSISTED_ID_PATTERN),
    runtimeId: z.enum(RUNTIME_IDS),
    title: z.string(),
    cwd: z.string().min(1),
    status: z.enum(SESSION_STATUSES),
    durabilityMode: z.enum(DURABILITY_MODES),
    bootstrapCode: z.string().optional(),
    checkpointRevision: z.string().optional(),
    checkpointUpdatedAtMs: z.number().finite().nonnegative().optional(),
    runtimeGeneration: z.number().int().nonnegative(),
    quarantineReason: z.string().min(1).optional(),
    createdAtMs: z.number().finite().nonnegative(),
    updatedAtMs: z.number().finite().nonnegative(),
    closed: z.boolean(),
    cols: z.number().int().positive().max(65_535),
    rows: z.number().int().positive().max(65_535),
  })
  .superRefine((entry, context) => {
    if (entry.closed !== (entry.status === "closed")) {
      context.addIssue({
        code: "custom",
        message: "catalog closed flag and status disagree",
      });
    }
    if (
      (entry.checkpointRevision === undefined) !==
      (entry.checkpointUpdatedAtMs === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "catalog checkpoint revision and timestamp must appear together",
      });
    }
    if (entry.status === "quarantined" && !entry.quarantineReason) {
      context.addIssue({
        code: "custom",
        message: "quarantined catalog entries require a reason",
      });
    }
    if (entry.status !== "quarantined" && entry.quarantineReason) {
      context.addIssue({
        code: "custom",
        message: "only quarantined catalog entries may carry a reason",
      });
    }
    if (
      entry.durabilityMode === "ephemeral" &&
      entry.checkpointRevision !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "ephemeral catalog entries may not claim a checkpoint",
      });
    }
    if (entry.updatedAtMs < entry.createdAtMs) {
      context.addIssue({
        code: "custom",
        message: "catalog update time precedes creation time",
      });
    }
    if (
      entry.checkpointUpdatedAtMs !== undefined &&
      entry.updatedAtMs < entry.checkpointUpdatedAtMs
    ) {
      context.addIssue({
        code: "custom",
        message: "catalog update time precedes its checkpoint time",
      });
    }
  });

export interface SessionCatalogFailure {
  sessionId: string;
  catalogFileName: string;
  persistedSessionId?: string;
  reason: string;
}

export interface SessionCatalogListing {
  entries: SessionCatalogEntry[];
  failures: SessionCatalogFailure[];
}

export class SessionCatalogStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  get sessionsDir(): string {
    return join(this.rootDir, "sessions");
  }

  entryPath(sessionId: string): string {
    return join(
      this.sessionsDir,
      `${assertSafePersistedId(sessionId, "session ID")}.json`,
    );
  }

  write(entry: SessionCatalogWrite): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    const validated = parseCatalogEntry(entry);
    const finalPath = this.entryPath(validated.sessionId);
    const tempPath = `${finalPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(validated, null, 2) + "\n", "utf8");
    renameSync(tempPath, finalPath);
  }

  read(sessionId: string): SessionCatalogEntry | null {
    const path = this.entryPath(sessionId);
    if (!existsSync(path)) return null;
    return parseCatalogEntry(JSON.parse(readFileSync(path, "utf8")));
  }

  list(): SessionCatalogListing {
    const entries: SessionCatalogEntry[] = [];
    const failures: SessionCatalogFailure[] = [];
    const fileNames = readdirSync(this.sessionsDir)
      .filter((entry) => entry.endsWith(".json"))
      .sort();
    const canonicalIds = new Set(
      fileNames
        .map((fileName) => fileName.slice(0, -".json".length))
        .filter((sessionId) => SAFE_PERSISTED_ID_PATTERN.test(sessionId)),
    );
    const allocatedFailureIds = new Set<string>();
    for (const fileName of fileNames) {
      const persistedSessionId = fileName.slice(0, -".json".length);
      const sessionId = SAFE_PERSISTED_ID_PATTERN.test(persistedSessionId)
        ? persistedSessionId
        : allocateCatalogFailureId(fileName, canonicalIds, allocatedFailureIds);
      allocatedFailureIds.add(sessionId);
      try {
        if (sessionId !== persistedSessionId) {
          throw new Error(
            `catalog filename ${JSON.stringify(fileName)} does not contain a safe persisted session ID`,
          );
        }
        const parsed = parseCatalogEntry(
          JSON.parse(readFileSync(join(this.sessionsDir, fileName), "utf8")),
        );
        if (parsed.sessionId !== sessionId) {
          throw new Error(
            `catalog session id ${parsed.sessionId} does not match filename ${sessionId}`,
          );
        }
        entries.push(parsed);
      } catch (error) {
        failures.push({
          sessionId,
          catalogFileName: fileName,
          ...(sessionId === persistedSessionId ? { persistedSessionId } : {}),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    entries.sort((left, right) => left.createdAtMs - right.createdAtMs);
    failures.sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
    return { entries, failures };
  }

  remove(sessionId: string): void {
    rmSync(this.entryPath(sessionId), { force: true });
  }

  removeCatalogFile(fileName: string): void {
    if (!fileName.endsWith(".json") || basename(fileName) !== fileName) {
      throw new Error(`invalid catalog filename: ${fileName}`);
    }
    rmSync(join(this.sessionsDir, fileName), { force: true });
  }
}

function allocateCatalogFailureId(
  fileName: string,
  canonicalIds: ReadonlySet<string>,
  allocatedFailureIds: ReadonlySet<string>,
): string {
  for (let nonce = 0; ; nonce += 1) {
    const digest = createHash("sha256")
      .update(nonce === 0 ? fileName : `${fileName}:${nonce}`)
      .digest("hex");
    const candidate = `corrupt_catalog_${digest}`;
    if (!canonicalIds.has(candidate) && !allocatedFailureIds.has(candidate)) {
      return candidate;
    }
  }
}

function parseCatalogEntry(value: unknown): SessionCatalogEntry {
  const normalized =
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("schemaVersion" in value)
      ? { schemaVersion: SESSION_CATALOG_SCHEMA_VERSION, ...value }
      : value;
  return SessionCatalogEntrySchema.parse(normalized);
}
