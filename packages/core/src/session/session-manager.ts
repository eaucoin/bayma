import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { aggregateFailure, failureDetail } from "../errors.ts";
import type { RuntimeId } from "../runtime/id.ts";
import type { RuntimeBinding, RuntimeRegistry } from "../runtime/registry.ts";
import type {
  RuntimeAdapter,
  RuntimeOutputCollector,
} from "../runtime/adapter.ts";
import { assertRuntimeCheckpointCompatible } from "../runtime/adapter.ts";
import type {
  RuntimeTransport,
  TransportChunkListener,
  TransportSessionHandle,
} from "../runtime/transport.ts";
import { createOpaqueId } from "../ids.ts";
import type {
  SessionEvent,
  SessionEventRecord,
  SessionEventSink,
} from "./events.ts";
import {
  SESSION_CATALOG_SCHEMA_VERSION,
  SessionCatalogStore,
  type SessionCatalogEntry,
} from "./catalog-store.ts";
import { ExecHistoryStore } from "./exec-history-store.ts";
import {
  CheckpointStore,
  type RuntimeCheckpointCommit,
  type RuntimeCheckpointSnapshot,
  type SessionCheckpoint,
} from "./checkpoint-store.ts";
import type {
  DurabilityMode,
  SessionDetail,
  SessionRole,
  SessionStatus,
  SessionSummary,
} from "./model.ts";
import {
  pickEvictionCandidate,
  shouldWarn,
  validateRetentionPolicy,
  type RetentionPolicy,
  type SessionSnapshot,
} from "./retention-policy.ts";
import { reconcileOrphanedExecs } from "./exec-recovery.ts";
import type {
  ExecInterruptionReason,
  ExecMessageRecord,
  ExecRecord,
} from "./exec-types.ts";
import { execTimestampAtOrAfterHistory } from "./exec-types.ts";
import { EventLog } from "./event-log.ts";
import {
  appendExecMessage,
  execFinishedEvent,
  execMessageEvent,
  ExecOutputCapture,
  finishExec,
} from "./exec-capture.ts";

export interface SessionRecord {
  sessionId: string;
  runtimeId?: RuntimeId;
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
  controllerActorId?: string;
  observerActorIds: Set<string>;
}

interface ActiveExec {
  record: ExecRecord;
  emitActors: boolean;
  commitCheckpoint: boolean;
  seq: number;
  collector: RuntimeOutputCollector;
  decoder: TextDecoder;
  capture: ExecOutputCapture;
  completion: Promise<void>;
  resolveCompletion: () => void;
  dispose?: () => void;
}

interface LiveRuntimeSession {
  handle: TransportSessionHandle;
  unsubscribe: () => void;
  queue: ExecRecord[];
  activeExec?: ActiveExec;
}

interface RecoveryState {
  canRecover: boolean;
  hasCheckpoint: boolean;
  lastAttemptAtMs?: number;
  lastError?: string;
}

interface SessionEntry {
  record: SessionRecord;
  history: ExecRecord[];
  runtime?: LiveRuntimeSession;
  cols: number;
  rows: number;
  recovery: RecoveryState;
  eventLog: EventLog;
  persistable?: boolean;
  catalogFailure?: {
    fileName: string;
    persistedSessionId?: string;
  };
  mutationTail: Promise<void>;
}

interface SubmitResult {
  sessionId: string;
  execId: string;
}

interface SessionMutationOptions {
  admittedBeforeShutdown?: boolean;
  allowClosed?: boolean;
}

interface InternalExecOptions {
  emitActors: boolean;
  commitCheckpoint: boolean;
  checkpoint?: RuntimeCheckpointSnapshot | null;
}

export interface SessionCreatePolicy {
  durabilityMode: DurabilityMode;
  bootstrapCode?: string;
  initialCheckpoint?: unknown;
}

export interface SessionManagerOptions extends RetentionPolicy {
  defaultCols: number;
  defaultRows: number;
  resolveCreatePolicy?: (request: {
    actorId: string;
    runtimeId: RuntimeId;
    title: string;
    cwd: string;
    role: SessionRole;
  }) => SessionCreatePolicy;
}

function validateTerminalDimension(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
}

export function validateSessionManagerOptions(
  options: SessionManagerOptions,
): void {
  validateRetentionPolicy(options);
  for (const [name, value] of [
    ["defaultCols", options.defaultCols],
    ["defaultRows", options.defaultRows],
  ] as const) {
    validateTerminalDimension(name, value);
  }
}

const PTY_DELTA_MAX_BYTES = 64 * 1024;

function execFailed(record: ExecRecord): boolean {
  return record.status === "error";
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly serverEventLog = new EventLog();
  private admissionMutationTail = Promise.resolve();
  private catalogLoaded = false;
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;

  private readonly registry: RuntimeRegistry;
  private readonly catalogStore: SessionCatalogStore;
  private readonly historyStore: ExecHistoryStore;
  private readonly checkpointStore: CheckpointStore;
  private readonly options: SessionManagerOptions;
  private readonly emit: SessionEventSink;

  constructor(
    registry: RuntimeRegistry,
    catalogStore: SessionCatalogStore,
    historyStore: ExecHistoryStore,
    checkpointStore: CheckpointStore,
    options: SessionManagerOptions,
    emit: SessionEventSink,
  ) {
    validateSessionManagerOptions(options);
    this.registry = registry;
    this.catalogStore = catalogStore;
    this.historyStore = historyStore;
    this.checkpointStore = checkpointStore;
    this.options = options;
    this.emit = emit;
  }

  async loadCatalog(): Promise<void> {
    if (this.catalogLoaded) {
      throw new Error("session catalog may only be loaded once");
    }
    this.catalogLoaded = true;
    const recoveredAtMs = Date.now();
    const catalog = this.catalogStore.list();
    for (const failure of catalog.failures) {
      const reason = `session catalog is unreadable: ${failure.reason}`;
      const record: SessionRecord = {
        sessionId: failure.sessionId,
        title: `Unreadable session ${failure.sessionId}`,
        cwd: this.catalogStore.rootDir,
        status: "quarantined",
        durabilityMode: "checkpointed",
        runtimeGeneration: 0,
        quarantineReason: reason,
        createdAtMs: recoveredAtMs,
        updatedAtMs: recoveredAtMs,
        observerActorIds: new Set(),
      };
      this.sessions.set(failure.sessionId, {
        record,
        history: [],
        cols: this.options.defaultCols,
        rows: this.options.defaultRows,
        recovery: {
          canRecover: false,
          hasCheckpoint: false,
          lastError: reason,
        },
        eventLog: new EventLog(),
        persistable: false,
        catalogFailure: {
          fileName: failure.catalogFileName,
          persistedSessionId: failure.persistedSessionId,
        },
        mutationTail: Promise.resolve(),
      });
    }

    for (const metadata of catalog.entries) {
      if (metadata.closed) {
        this.removePersistedSession(metadata.sessionId);
        continue;
      }
      let history: ExecRecord[] = [];
      let historyFailure: string | undefined;
      try {
        history = reconcileOrphanedExecs(
          this.historyStore.read(metadata.sessionId),
          recoveredAtMs,
        ).history;
      } catch (error) {
        historyFailure = `session history is unreadable: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      const checkpointRead = this.checkpointStore.inspect(metadata.sessionId);
      const checkpoint = checkpointRead.checkpoint;
      const normalized = historyFailure
        ? {
            ...metadata,
            status: "quarantined" as const,
            quarantineReason: historyFailure,
            closed: false,
          }
        : checkpointRead.failure
          ? {
              ...metadata,
              checkpointRevision: undefined,
              checkpointUpdatedAtMs: undefined,
              status: "quarantined" as const,
              quarantineReason: checkpointRead.failure,
              closed: false,
            }
          : this.normalizeCatalogEntry(metadata, checkpoint);
      if (normalized.closed) {
        this.removePersistedSession(normalized.sessionId);
        continue;
      }
      const record: SessionRecord = {
        sessionId: normalized.sessionId,
        runtimeId: normalized.runtimeId,
        title: normalized.title,
        cwd: normalized.cwd,
        status: normalized.status,
        durabilityMode: normalized.durabilityMode,
        bootstrapCode: normalized.bootstrapCode,
        checkpointRevision: normalized.checkpointRevision,
        checkpointUpdatedAtMs: normalized.checkpointUpdatedAtMs,
        runtimeGeneration: normalized.runtimeGeneration,
        quarantineReason: normalized.quarantineReason,
        createdAtMs: normalized.createdAtMs,
        updatedAtMs: normalized.updatedAtMs,
        observerActorIds: new Set(),
      };
      const recovery = this.buildRecoveryState(record, checkpoint);
      const entry: SessionEntry = {
        record,
        history,
        cols: normalized.cols,
        rows: normalized.rows,
        recovery,
        eventLog: new EventLog(),
        persistable: historyFailure === undefined,
        mutationTail: Promise.resolve(),
      };
      if (entry.persistable) {
        this.persist(entry);
      }
      this.sessions.set(record.sessionId, entry);
    }
  }

  /** The runtimes this engine hosts, in canonical order. */
  runtimeIds(): RuntimeId[] {
    return this.registry.runtimeIds();
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((session) =>
      this.toSummary(session),
    );
  }

  detail(sessionId: string): SessionDetail {
    const session = this.requireSession(sessionId);
    return this.toDetail(session);
  }

  execs(sessionId: string): ExecRecord[] {
    return this.requireSession(sessionId).history.map(cloneExecRecord);
  }

  execIds(sessionId: string): string[] {
    return this.requireSession(sessionId).history.map(
      (record) => record.execId,
    );
  }

  exec(sessionId: string, execId: string): ExecRecord {
    return cloneExecRecord(
      this.requireExec(this.requireSession(sessionId), execId),
    );
  }

  execMessages(
    sessionId: string,
    execId: string,
    fromSeq = 1,
  ): ExecMessageRecord[] {
    return this.requireExec(this.requireSession(sessionId), execId)
      .messages.filter((message) => message.seq >= fromSeq)
      .map((message) => ({ ...message }));
  }

  events(sessionId: string, fromSeq = 1): SessionEventRecord[] {
    return this.requireSession(sessionId).eventLog.since(fromSeq);
  }

  serverEvents(fromSeq = 1): SessionEventRecord[] {
    return this.serverEventLog.since(fromSeq);
  }

  checkpoint(sessionId: string): SessionCheckpoint | null {
    return this.checkpointStore.read(sessionId);
  }

  recoveryState(sessionId: string): RecoveryState {
    return { ...this.requireSession(sessionId).recovery };
  }

  async create(
    actorId: string,
    title: string,
    cwd: string,
    role: SessionRole = "controller",
    runtimeId: RuntimeId = this.registry.onlyRuntimeId(),
  ): Promise<SessionSummary> {
    return this.createWithPolicy(
      actorId,
      title,
      cwd,
      this.resolveCreatePolicy(actorId, runtimeId, title, cwd, role),
      role,
      runtimeId,
    );
  }

  async createWithPolicy(
    actorId: string,
    title: string,
    cwd: string,
    policy: SessionCreatePolicy,
    role: SessionRole = "controller",
    runtimeId: RuntimeId = this.registry.onlyRuntimeId(),
  ): Promise<SessionSummary> {
    return this.withAdmissionMutation(() =>
      this.createWithPolicyUnlocked(
        actorId,
        runtimeId,
        title,
        cwd,
        policy,
        role,
      ),
    );
  }

  private async createWithPolicyUnlocked(
    actorId: string,
    runtimeId: RuntimeId,
    title: string,
    cwd: string,
    policy: SessionCreatePolicy,
    role: SessionRole,
  ): Promise<SessionSummary> {
    const sessionId = this.allocateSessionId();
    await this.makeRoomIfNeeded();
    const { durabilityMode, bootstrapCode, initialCheckpoint } = policy;

    const createdAtMs = Date.now();
    const record: SessionRecord = {
      sessionId,
      runtimeId,
      title,
      cwd,
      status: "recovering",
      durabilityMode,
      bootstrapCode,
      runtimeGeneration: 0,
      createdAtMs,
      updatedAtMs: createdAtMs,
      controllerActorId: role === "controller" ? actorId : undefined,
      observerActorIds: role === "observer" ? new Set([actorId]) : new Set(),
    };
    const entry: SessionEntry = {
      record,
      history: [],
      cols: this.options.defaultCols,
      rows: this.options.defaultRows,
      recovery: {
        canRecover: false,
        hasCheckpoint: false,
      },
      eventLog: new EventLog(),
      mutationTail: Promise.resolve(),
    };
    let releaseInitialization: () => void = () => {};
    entry.mutationTail = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    this.sessions.set(sessionId, entry);

    try {
      if (
        durabilityMode === "checkpointed" &&
        initialCheckpoint !== undefined
      ) {
        this.commitCheckpointValue(entry, initialCheckpoint, runtimeId);
      }
      await this.spawnRuntime(entry, "create");
      entry.record.status = "live_idle";
      this.touchSession(entry);
      this.persist(entry);
    } catch (error) {
      const reason = failureDetail(error);
      if (durabilityMode === "checkpointed") {
        await this.quarantineSession(entry, reason);
      } else {
        const cleanupFailures: unknown[] = [];
        try {
          await this.stopRuntime(entry);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        try {
          this.removePersistedSession(sessionId);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        } finally {
          this.sessions.delete(sessionId);
        }
        if (cleanupFailures.length > 0) {
          throw aggregateFailure(
            `failed to create and clean up session ${sessionId}`,
            [error, ...cleanupFailures],
          );
        }
      }
      throw error;
    } finally {
      releaseInitialization();
    }
    this.emitToActors(this.actorRecipients(entry.record), {
      type: "session/started",
      sessionId,
      status: entry.record.status,
    });
    this.emitToActors(this.actorRecipients(entry.record), {
      type: "session/actorJoined",
      sessionId,
      role,
      actorId,
    });
    return this.toSummary(entry);
  }

  async attach(
    sessionId: string,
    actorId: string,
    role: SessionRole,
  ): Promise<SessionSummary> {
    return this.withSessionMutation(sessionId, async (session) => {
      if (role === "controller") {
        if (
          session.record.controllerActorId &&
          session.record.controllerActorId !== actorId
        ) {
          throw new Error("controller lease already held");
        }
        session.record.observerActorIds.delete(actorId);
        session.record.controllerActorId = actorId;
        this.emitToActors(this.actorRecipients(session.record), {
          type: "session/controllerChanged",
          sessionId,
          actorId,
        });
      } else {
        if (session.record.controllerActorId === actorId) {
          throw new Error("controller actor cannot also attach as an observer");
        }
        session.record.observerActorIds.add(actorId);
      }
      this.touchSession(session);
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/actorJoined",
        sessionId,
        role,
        actorId,
      });
      return this.toSummary(session);
    });
  }

  async detach(sessionId: string, actorId: string): Promise<SessionSummary> {
    return this.withSessionMutation(sessionId, async (session) => {
      if (session.record.controllerActorId === actorId) {
        session.record.controllerActorId = undefined;
        this.emitToActors(this.actorRecipients(session.record), {
          type: "session/controllerChanged",
          sessionId,
        });
      }
      session.record.observerActorIds.delete(actorId);
      this.touchSession(session);
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/actorLeft",
        sessionId,
        actorId,
      });
      return this.toSummary(session);
    });
  }

  async recoverSession(
    sessionId: string,
    actorId: string,
  ): Promise<SessionSummary> {
    return this.withAdmissionMutation(() =>
      this.withSessionMutation(
        sessionId,
        async (session) => {
          this.assertController(session.record, actorId);
          if (!session.runtime) await this.makeRoomIfNeeded();
          await this.ensureRuntime(session);
          return this.toSummary(session);
        },
        { admittedBeforeShutdown: true },
      ),
    );
  }

  async setBootstrap(
    sessionId: string,
    actorId: string,
    bootstrapCode?: string,
  ): Promise<SessionSummary> {
    return this.withSessionMutation(sessionId, async (session) => {
      this.assertController(session.record, actorId);
      const previousBootstrapCode = session.record.bootstrapCode;
      const previousRecovery = session.recovery;
      const previousUpdatedAtMs = session.record.updatedAtMs;
      const checkpointRead = this.checkpointStore.inspect(sessionId);
      if (checkpointRead.failure) {
        throw new Error(checkpointRead.failure);
      }
      if (checkpointRead.checkpoint) {
        assertRuntimeCheckpointCompatible(
          this.adapter(session),
          checkpointRead.checkpoint,
        );
      }
      session.record.bootstrapCode = bootstrapCode;
      this.touchSession(session);
      session.recovery = this.buildRecoveryState(
        session.record,
        checkpointRead.checkpoint,
      );
      try {
        this.persist(session);
      } catch (error) {
        session.record.bootstrapCode = previousBootstrapCode;
        session.record.updatedAtMs = previousUpdatedAtMs;
        session.recovery = previousRecovery;
        throw error;
      }
      return this.toSummary(session);
    });
  }

  async resize(
    sessionId: string,
    actorId: string,
    cols: number,
    rows: number,
  ): Promise<SessionSummary> {
    validateTerminalDimension("cols", cols);
    validateTerminalDimension("rows", rows);
    return this.withSessionMutation(sessionId, async (session) => {
      this.assertController(session.record, actorId);
      try {
        const runtime = session.runtime;
        if (runtime) {
          await this.transport(session).resize(runtime.handle, { cols, rows });
          if (session.runtime !== runtime) {
            throw new Error(
              session.record.quarantineReason ??
                "runtime changed while resize was in flight",
            );
          }
        }
        session.cols = cols;
        session.rows = rows;
        this.touchSession(session);
        this.persist(session);
      } catch (error) {
        await this.quarantineSession(
          session,
          `session resize failed: ${failureDetail(error)}`,
        );
        throw error;
      }
      return this.toSummary(session);
    });
  }

  async submitExec(
    sessionId: string,
    actorId: string,
    code: string,
  ): Promise<SubmitResult> {
    return this.withAdmissionMutation(() =>
      this.withSessionMutation(
        sessionId,
        async (session) => {
          this.assertController(session.record, actorId);
          if (!session.runtime) await this.makeRoomIfNeeded();
          await this.ensureRuntime(session);
          const execId = this.allocateExecId(session);

          const record: ExecRecord = {
            execId,
            code,
            status: "queued",
            submittedAtMs: Math.max(
              Date.now(),
              session.history.at(-1)?.submittedAtMs ?? 0,
            ),
            messages: [],
          };
          session.history.push(record);
          this.touchSession(session);
          session.runtime!.queue.push(record);
          try {
            this.persist(session);
          } catch (error) {
            await this.quarantineSession(
              session,
              `exec submission persistence failed: ${failureDetail(error)}`,
            );
            throw error;
          }
          void this.drainExecQueue(session);
          return { sessionId, execId };
        },
        { admittedBeforeShutdown: true },
      ),
    );
  }

  async resetToCheckpoint(
    sessionId: string,
    actorId: string,
  ): Promise<SessionSummary> {
    return this.withAdmissionMutation(() =>
      this.withSessionMutation(
        sessionId,
        async (session) => {
          this.assertController(session.record, actorId);
          if (session.record.durabilityMode !== "checkpointed") {
            throw new Error(
              "reset to checkpoint requires a checkpointed session",
            );
          }
          this.requireCompatibleCheckpoint(sessionId);
          if (!session.runtime) await this.makeRoomIfNeeded();
          await this.recycleRuntime(session, "reset to checkpoint");
          return this.toSummary(session);
        },
        { admittedBeforeShutdown: true },
      ),
    );
  }

  async interrupt(sessionId: string, actorId: string): Promise<SessionSummary> {
    return this.withSessionMutation(sessionId, async (session) => {
      this.assertController(session.record, actorId);
      const active = session.runtime?.activeExec;
      if (!active || !session.runtime) return this.toSummary(session);
      const runtime = session.runtime;

      let interruptMode: "soft" | "recycle";
      try {
        active.capture.completionStatus = "interrupted";
        interruptMode = await this.transport(session).interrupt(runtime.handle);
        if (session.runtime !== runtime) {
          throw new Error(
            session.record.quarantineReason ??
              "runtime changed while interrupt was in flight",
          );
        }
        if (runtime.activeExec !== active) return this.toSummary(session);
        this.finalizeInterruptedExec(session, active.record.execId);
      } catch (error) {
        await this.quarantineSession(
          session,
          `session interrupt failed: ${failureDetail(error)}`,
        );
        throw error;
      }
      if (interruptMode === "recycle") {
        await this.recycleRuntime(session, "interrupt", {
          allowFresh: true,
        });
      } else {
        session.record.status = "live_idle";
        this.touchSession(session);
        this.persist(session);
        this.emitToActors(this.actorRecipients(session.record), {
          type: "session/statusChanged",
          sessionId,
          status: "live_idle",
          reason: "interrupted",
        });
      }
      return this.toSummary(session);
    });
  }

  async close(sessionId: string, actorId: string): Promise<SessionSummary> {
    return this.withSessionMutation(
      sessionId,
      async (session) => {
        this.assertController(session.record, actorId);
        await this.stopRuntime(session, "controller_request");
        return this.finalizeSessionRemoval(session, "closed");
      },
      { allowClosed: true },
    );
  }

  async releaseActor(actorId: string): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        await this.withSessionMutation(sessionId, async (session) => {
          const wasController = session.record.controllerActorId === actorId;
          const wasObserver = session.record.observerActorIds.delete(actorId);
          if (wasController) {
            session.record.controllerActorId = undefined;
            this.emitToActors(this.actorRecipients(session.record), {
              type: "session/controllerChanged",
              sessionId: session.record.sessionId,
            });
          }
          if (wasController || wasObserver) {
            this.touchSession(session);
          }
        });
      } catch (error) {
        if (this.sessions.has(sessionId)) throw error;
      }
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    await this.admissionMutationTail;
    await Promise.all(
      [...this.sessions.values()].map((session) => session.mutationTail),
    );
    const failures: unknown[] = [];
    for (const session of [...this.sessions.values()]) {
      session.record.controllerActorId = undefined;
      session.record.observerActorIds.clear();
      const hadRuntime = session.runtime !== undefined;
      if (hadRuntime) {
        try {
          await this.stopRuntime(session, "server_restart");
        } catch (error) {
          failures.push(error);
        }
      }
      if (session.record.durabilityMode === "checkpointed") {
        if (hadRuntime) {
          const checkpointRead = this.checkpointStore.inspect(
            session.record.sessionId,
          );
          const checkpoint = checkpointRead.checkpoint;
          let checkpointFailure = checkpointRead.failure;
          if (checkpoint && !checkpointFailure) {
            try {
              assertRuntimeCheckpointCompatible(
                this.adapter(session),
                checkpoint,
              );
            } catch (error) {
              checkpointFailure =
                error instanceof Error ? error.message : String(error);
            }
          }
          if (session.record.status !== "quarantined") {
            if (checkpointFailure) {
              session.record.status = "quarantined";
              session.record.quarantineReason = checkpointFailure;
            } else if (checkpoint) {
              session.record.status = "suspended";
              session.record.quarantineReason = undefined;
            } else {
              session.record.status = "quarantined";
              session.record.quarantineReason = "checkpoint is missing";
            }
          }
          this.touchSession(session);
          session.recovery = this.buildRecoveryState(
            session.record,
            checkpoint,
          );
          try {
            this.persist(session);
          } catch (error) {
            failures.push(error);
          }
        }
      } else {
        try {
          this.removePersistedSession(session.record.sessionId);
        } catch (error) {
          failures.push(error);
        } finally {
          this.sessions.delete(session.record.sessionId);
        }
      }
    }
    try {
      await this.registry.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw aggregateFailure("session manager shutdown failed", failures);
    }
  }

  private async withAdmissionMutation<T>(
    mutation: () => Promise<T>,
  ): Promise<T> {
    this.assertAcceptingMutations();
    const predecessor = this.admissionMutationTail;
    let release: () => void = () => {};
    this.admissionMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  private async withSessionMutation<T>(
    sessionId: string,
    mutation: (session: SessionEntry) => Promise<T>,
    options: SessionMutationOptions = {},
  ): Promise<T> {
    if (!options.admittedBeforeShutdown) this.assertAcceptingMutations();
    const session = this.requireSession(sessionId);
    const predecessor = session.mutationTail;
    let release: () => void = () => {};
    session.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      if (this.sessions.get(sessionId) !== session) {
        throw new Error(`unknown session ${sessionId}`);
      }
      if (session.record.status === "closed" && !options.allowClosed) {
        throw new Error(`session ${sessionId} is closed`);
      }
      return await mutation(session);
    } finally {
      release();
    }
  }

  private assertAcceptingMutations(): void {
    if (this.shuttingDown) {
      throw new Error("session manager is shutting down");
    }
  }

  private actorRecipients(record: SessionRecord): string[] {
    return [
      ...new Set(
        [record.controllerActorId, ...record.observerActorIds].filter(
          (actorId): actorId is string => actorId !== undefined,
        ),
      ),
    ];
  }

  private emitToActors(actorIds: string[], event: SessionEvent): void {
    this.recordEvent(event);
    try {
      this.emit({ actorIds, event });
    } catch {
      // Notifications project authoritative state and never control mutations.
    }
  }

  private async makeRoomIfNeeded(): Promise<void> {
    const liveSessions = () =>
      [...this.sessions.values()]
        .filter(
          (session) => session.runtime && session.record.status !== "closed",
        )
        .map((session) => this.toSnapshot(session.record));
    let current = liveSessions();
    const nextCount = current.length + 1;

    if (shouldWarn(this.options, nextCount)) {
      const actorIds = [
        ...new Set(
          current.flatMap((snapshot) =>
            this.actorRecipients(
              this.requireSession(snapshot.sessionId).record,
            ),
          ),
        ),
      ];
      this.emitToActors(actorIds, {
        type: "session/pressureWarning",
        liveSessions: nextCount,
        maxSessions: this.options.maxSessions,
      });
    }

    while (current.length + 1 > this.options.maxSessions) {
      const victim = pickEvictionCandidate(current);
      if (!victim) {
        throw new Error("session capacity exhausted");
      }
      try {
        await this.withSessionMutation(
          victim.sessionId,
          async (session) => {
            const stillEvictable = pickEvictionCandidate([
              this.toSnapshot(session.record),
            ]);
            if (!session.runtime || !stillEvictable) return;
            this.emitToActors(this.actorRecipients(session.record), {
              type: "session/evictionScheduled",
              sessionId: session.record.sessionId,
              reason: "max sessions reached",
            });
            await this.stopRuntime(session);
            this.finalizeSessionRemoval(session, "evicted");
          },
          { admittedBeforeShutdown: true },
        );
      } catch (error) {
        if (this.sessions.has(victim.sessionId)) throw error;
      }
      current = liveSessions();
    }
  }

  private toSnapshot(record: SessionRecord): SessionSnapshot {
    return {
      sessionId: record.sessionId,
      createdAtMs: record.createdAtMs,
      busy: record.status === "live_busy" || record.status === "recovering",
      controllerActorId: record.controllerActorId,
      status: record.status,
    };
  }

  private toSummary(session: SessionEntry): SessionSummary {
    const record = session.record;
    return {
      sessionId: record.sessionId,
      runtimeId: record.runtimeId,
      title: record.title,
      cwd: record.cwd,
      status: record.status,
      quarantineReason: record.quarantineReason,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
      controllerActorId: record.controllerActorId,
      observerActorIds: [...record.observerActorIds],
      historyLength: session.history.length,
    };
  }

  private toDetail(session: SessionEntry): SessionDetail {
    return {
      ...this.toSummary(session),
      activeExecId: session.runtime?.activeExec?.record.execId,
      queuedExecIds:
        session.runtime?.queue.map((submission) => submission.execId) ?? [],
      latestExecId: session.history.at(-1)?.execId,
      execCount: session.history.length,
    };
  }

  private resolveCreatePolicy(
    actorId: string,
    runtimeId: RuntimeId,
    title: string,
    cwd: string,
    role: SessionRole,
  ): SessionCreatePolicy {
    return (
      this.options.resolveCreatePolicy?.({
        actorId,
        runtimeId,
        title,
        cwd,
        role,
      }) ?? {
        durabilityMode: "ephemeral",
      }
    );
  }

  private assertController(record: SessionRecord, actorId: string): void {
    if (record.controllerActorId !== actorId) {
      throw new Error("write action requires controller lease");
    }
  }

  /** The runtime a session is bound to; a session without one is unreadable state. */
  private binding(session: SessionEntry): RuntimeBinding {
    const { runtimeId } = session.record;
    if (!runtimeId) {
      throw new Error(`session ${session.record.sessionId} has no runtime`);
    }
    return this.registry.get(runtimeId);
  }

  private adapter(session: SessionEntry): RuntimeAdapter {
    return this.binding(session).adapter;
  }

  private transport(session: SessionEntry): RuntimeTransport {
    return this.binding(session).transport;
  }

  private requireSession(sessionId: string): SessionEntry {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }

  private allocateExecId(session: SessionEntry): string {
    while (true) {
      const execId = createOpaqueId("exec");
      if (
        session.history.some((entry) => entry.execId === execId) ||
        session.runtime?.activeExec?.record.execId === execId ||
        session.runtime?.queue.some((queued) => queued.execId === execId)
      ) {
        continue;
      }
      return execId;
    }
  }

  private allocateSessionId(): string {
    while (true) {
      const sessionId = createOpaqueId("sess");
      if (!this.sessions.has(sessionId)) return sessionId;
    }
  }

  private requireExec(session: SessionEntry, execId: string): ExecRecord {
    const exec = session.history.find((entry) => entry.execId === execId);
    if (!exec) throw new Error(`unknown exec ${execId}`);
    return exec;
  }

  private persist(session: SessionEntry): void {
    if (session.persistable === false) return;
    const runtimeId = session.record.runtimeId;
    if (!runtimeId) {
      throw new Error(`session ${session.record.sessionId} has no runtime`);
    }
    session.record.updatedAtMs = Math.max(
      session.record.updatedAtMs,
      session.record.createdAtMs,
      session.record.checkpointUpdatedAtMs ?? 0,
    );
    const metadata: SessionCatalogEntry = {
      schemaVersion: SESSION_CATALOG_SCHEMA_VERSION,
      sessionId: session.record.sessionId,
      runtimeId,
      title: session.record.title,
      cwd: session.record.cwd,
      status: session.record.status,
      durabilityMode: session.record.durabilityMode,
      bootstrapCode: session.record.bootstrapCode,
      checkpointRevision: session.record.checkpointRevision,
      checkpointUpdatedAtMs: session.record.checkpointUpdatedAtMs,
      runtimeGeneration: session.record.runtimeGeneration,
      quarantineReason: session.record.quarantineReason,
      createdAtMs: session.record.createdAtMs,
      updatedAtMs: session.record.updatedAtMs,
      closed: session.record.status === "closed",
      cols: session.runtime?.handle.cols ?? session.cols,
      rows: session.runtime?.handle.rows ?? session.rows,
    };
    // Durable history is the source for orphan reconciliation. Persist it first so a
    // catalog-write crash can only leave recoverable, already-terminal history behind.
    this.historyStore.write(session.record.sessionId, session.history);
    this.catalogStore.write(metadata);
  }

  private normalizeCatalogEntry(
    entry: SessionCatalogEntry,
    checkpoint: SessionCheckpoint | null,
  ): SessionCatalogEntry {
    const alignedEntry: SessionCatalogEntry = {
      ...entry,
      checkpointRevision: checkpoint?.revision,
      checkpointUpdatedAtMs: checkpoint?.updatedAtMs,
      updatedAtMs: Math.max(entry.updatedAtMs, checkpoint?.updatedAtMs ?? 0),
    };
    if (entry.durabilityMode === "ephemeral") {
      return {
        ...alignedEntry,
        status: "closed",
        closed: true,
      };
    }
    if (entry.status === "quarantined") {
      return {
        ...alignedEntry,
        closed: false,
      };
    }
    if (checkpoint) {
      try {
        assertRuntimeCheckpointCompatible(
          this.registry.get(entry.runtimeId).adapter,
          checkpoint,
        );
      } catch (error) {
        return {
          ...alignedEntry,
          status: "quarantined",
          quarantineReason:
            error instanceof Error ? error.message : String(error),
          closed: false,
        };
      }
    }
    return {
      ...alignedEntry,
      status: checkpoint ? "suspended" : "quarantined",
      quarantineReason: checkpoint ? undefined : "checkpoint is missing",
      closed: false,
    };
  }

  private buildRecoveryState(
    record: SessionRecord,
    checkpoint: SessionCheckpoint | null,
  ): RecoveryState {
    return {
      canRecover:
        record.durabilityMode === "checkpointed" &&
        record.status !== "quarantined" &&
        checkpoint !== null,
      hasCheckpoint: checkpoint !== null,
      lastError: record.quarantineReason,
    };
  }

  private requireCompatibleCheckpoint(sessionId: string): SessionCheckpoint {
    const inspected = this.checkpointStore.inspect(sessionId);
    if (!inspected.checkpoint) {
      throw new Error(inspected.failure ?? "checkpoint is missing");
    }
    assertRuntimeCheckpointCompatible(
      this.adapter(this.requireSession(sessionId)),
      inspected.checkpoint,
    );
    return inspected.checkpoint;
  }

  private async ensureRuntime(session: SessionEntry): Promise<void> {
    if (session.record.status === "quarantined") {
      throw new Error(
        session.record.quarantineReason ?? "session is quarantined",
      );
    }
    if (session.runtime) return;
    if (session.record.durabilityMode !== "checkpointed") {
      throw new Error(
        "ephemeral sessions do not support recovery after process restart",
      );
    }
    try {
      this.requireCompatibleCheckpoint(session.record.sessionId);
      session.record.status = "recovering";
      this.touchSession(session);
      session.recovery.lastAttemptAtMs = session.record.updatedAtMs;
      this.persist(session);
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/recoveryStarted",
        sessionId: session.record.sessionId,
        runtimeGeneration: session.record.runtimeGeneration + 1,
      });
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/statusChanged",
        sessionId: session.record.sessionId,
        status: "recovering",
      });
      await this.spawnRuntime(session, "recovery");
      await this.hydrateFromCheckpoint(session);
      session.record.status = "live_idle";
      session.record.quarantineReason = undefined;
      session.recovery.lastError = undefined;
      this.touchSession(session);
      this.persist(session);
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/recoveryFinished",
        sessionId: session.record.sessionId,
        runtimeGeneration: session.record.runtimeGeneration,
      });
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/statusChanged",
        sessionId: session.record.sessionId,
        status: "live_idle",
      });
    } catch (error) {
      await this.quarantineSession(session, failureDetail(error));
      throw error;
    }
  }

  private async spawnRuntime(
    session: SessionEntry,
    reason: "create" | "recovery" | "recycle",
  ): Promise<void> {
    const queued = await this.stopRuntime(
      session,
      "runtime_stopped",
      reason === "recycle",
    );
    const transport = this.transport(session);
    let runtime: LiveRuntimeSession | undefined;
    try {
      const handle = await transport.startSession({
        sessionId: session.record.sessionId,
        title: session.record.title,
        cwd: session.record.cwd,
        cols: session.cols,
        rows: session.rows,
      });
      const startedRuntime: LiveRuntimeSession = {
        handle,
        queue: queued,
        unsubscribe: () => undefined,
      };
      runtime = startedRuntime;
      session.runtime = startedRuntime;
      await transport.waitForInitialPrompt(handle);
      session.record.runtimeGeneration += 1;
      const listener: TransportChunkListener = (chunk) =>
        this.onBrokerChunk(session, chunk);
      startedRuntime.unsubscribe = await transport.subscribe(
        handle,
        listener,
        (error) => this.onRuntimeExit(session, startedRuntime.handle, error),
      );
      if (
        session.runtime !== startedRuntime ||
        session.record.status === "quarantined"
      ) {
        throw new Error(
          `runtime ${session.record.sessionId} exited during subscription`,
        );
      }
      session.cols = handle.cols;
      session.rows = handle.rows;
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      if (runtime) {
        try {
          runtime.unsubscribe();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        try {
          await this.transport(session).terminate(runtime.handle);
          if (session.runtime === runtime) session.runtime = undefined;
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      }
      if (queued.length > 0) {
        session.history = reconcileOrphanedExecs(
          session.history,
          Date.now(),
          "runtime_stopped",
        ).history;
        if (runtime) runtime.queue.length = 0;
      }
      if (cleanupFailures.length > 0) {
        throw aggregateFailure(
          `runtime ${session.record.sessionId} failed to start and cleanup was incomplete`,
          [error, ...cleanupFailures],
        );
      }
      throw error;
    }
    if (reason === "recycle") {
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/runtimeRecycled",
        sessionId: session.record.sessionId,
        runtimeGeneration: session.record.runtimeGeneration,
        reason,
      });
    }
  }

  private async stopRuntime(
    session: SessionEntry,
    interruptionReason: ExecInterruptionReason = "runtime_stopped",
    preserveQueued = false,
  ): Promise<ExecRecord[]> {
    const runtime = session.runtime;
    if (!runtime) return [];
    const queued = this.terminalizeRuntimeExecs(
      session,
      interruptionReason,
      preserveQueued,
    );
    const failures: unknown[] = [];
    try {
      this.persist(session);
    } catch (error) {
      failures.push(error);
    }
    try {
      runtime.unsubscribe();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.transport(session).terminate(runtime.handle);
      if (session.runtime === runtime) session.runtime = undefined;
    } catch (error) {
      if (queued.length > 0) {
        session.history = reconcileOrphanedExecs(
          session.history,
          Date.now(),
          "runtime_stopped",
        ).history;
        try {
          this.persist(session);
        } catch (persistError) {
          failures.push(persistError);
        }
      }
      failures.push(error);
    }
    if (failures.length > 0) {
      throw aggregateFailure(
        `failed to stop runtime for ${session.record.sessionId}`,
        failures,
      );
    }
    return queued;
  }

  private terminalizeRuntimeExecs(
    session: SessionEntry,
    interruptionReason: ExecInterruptionReason,
    preserveQueued: boolean,
  ): ExecRecord[] {
    const runtime = session.runtime;
    if (!runtime) return [];
    const queued = preserveQueued ? [...runtime.queue] : [];
    const queuedById = new Map(queued.map((record) => [record.execId, record]));
    runtime.queue.length = 0;
    const interruptedAtMs = Date.now();
    session.history = reconcileOrphanedExecs(
      session.history,
      interruptedAtMs,
      interruptionReason,
    ).history.map((record) => queuedById.get(record.execId) ?? record);
    const active = runtime.activeExec;
    runtime.activeExec = undefined;
    if (active) {
      this.disposeActive(active);
      active.resolveCompletion();
    }
    session.record.updatedAtMs = Math.max(
      session.record.updatedAtMs,
      interruptedAtMs,
    );
    return queued;
  }

  private removePersistedSession(
    sessionId: string,
    catalogFailure?: SessionEntry["catalogFailure"],
  ): void {
    // Remove the catalog authority first. A later cleanup failure may strand
    // inert payloads, but it cannot leave a discoverable session that a new
    // process would recover.
    if (catalogFailure) {
      this.catalogStore.removeCatalogFile(catalogFailure.fileName);
      if (!catalogFailure.persistedSessionId) return;
      sessionId = catalogFailure.persistedSessionId;
    } else {
      this.catalogStore.remove(sessionId);
    }
    this.historyStore.remove(sessionId);
    this.checkpointStore.remove(sessionId);
  }

  private finalizeSessionRemoval(
    session: SessionEntry,
    reason: "closed" | "evicted",
  ): SessionSummary {
    if (session.runtime) {
      throw new Error(
        `cannot remove session ${session.record.sessionId} with a live runtime`,
      );
    }
    session.record.status = "closed";
    this.touchSession(session);

    // The tombstone lets this process reject every operation except a close
    // retry when multi-file cleanup fails. Cleanup is still attempted if the
    // tombstone write fails: catalog-first deletion is the stronger fail-closed
    // boundary because orphaned history/checkpoints are not discoverable.
    let tombstoneFailure: unknown;
    try {
      this.persist(session);
    } catch (error) {
      tombstoneFailure = error;
    }
    try {
      this.removePersistedSession(
        session.record.sessionId,
        session.catalogFailure,
      );
    } catch (error) {
      throw aggregateFailure(
        `failed to remove persisted session ${session.record.sessionId}`,
        tombstoneFailure === undefined ? [error] : [tombstoneFailure, error],
      );
    }

    this.sessions.delete(session.record.sessionId);
    this.emitToActors(this.actorRecipients(session.record), {
      type: "session/closed",
      sessionId: session.record.sessionId,
      reason,
    });
    return this.toSummary(session);
  }

  private async hydrateFromCheckpoint(session: SessionEntry): Promise<void> {
    const checkpoint = this.requireCompatibleCheckpoint(
      session.record.sessionId,
    );
    if (!session.record.bootstrapCode) {
      session.recovery = this.buildRecoveryState(session.record, checkpoint);
      return;
    }
    const record: ExecRecord = {
      execId: `internal_recover_${session.record.runtimeGeneration}`,
      code: session.record.bootstrapCode,
      status: "queued",
      submittedAtMs: Date.now(),
      messages: [],
    };
    await this.runExec(session, record, {
      emitActors: false,
      commitCheckpoint: false,
      checkpoint: this.checkpointStore.snapshot(session.record.sessionId),
    });
    if (record.status !== "ok") {
      const message =
        record.messages.find((entry) => entry.kind === "error")?.text ??
        "bootstrap failed";
      throw new Error(message);
    }
    session.recovery = this.buildRecoveryState(session.record, checkpoint);
  }

  private async recycleRuntime(
    session: SessionEntry,
    reason: string,
    options: { allowFresh?: boolean } = {},
  ): Promise<void> {
    try {
      const checkpoint =
        session.record.durabilityMode === "checkpointed"
          ? this.requireCompatibleCheckpoint(session.record.sessionId)
          : null;
      await this.spawnRuntime(session, "recycle");
      if (session.record.durabilityMode === "checkpointed" && checkpoint) {
        await this.hydrateFromCheckpoint(session);
      } else if (!options.allowFresh) {
        throw new Error(
          "soft interrupt failed and no committed checkpoint is available for recycle",
        );
      } else {
        session.recovery = this.buildRecoveryState(session.record, checkpoint);
      }
      session.record.status = "live_idle";
      session.record.quarantineReason = undefined;
      session.recovery.lastError = undefined;
      this.touchSession(session);
      this.persist(session);
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/statusChanged",
        sessionId: session.record.sessionId,
        status: "live_idle",
        reason,
      });
      void this.drainExecQueue(session);
    } catch (error) {
      await this.quarantineSession(session, failureDetail(error));
      throw error;
    }
  }

  private async quarantineSession(
    session: SessionEntry,
    reason: string,
  ): Promise<void> {
    this.setQuarantinedState(session, reason);
    try {
      this.persist(session);
    } catch (error) {
      this.appendQuarantineReason(
        session,
        "quarantine persistence failed",
        error,
      );
    }
    const actorIds = this.actorRecipients(session.record);
    this.emitToActors(actorIds, {
      type: "session/quarantined",
      sessionId: session.record.sessionId,
      reason: session.record.quarantineReason ?? reason,
    });
    this.emitToActors(actorIds, {
      type: "session/statusChanged",
      sessionId: session.record.sessionId,
      status: "quarantined",
      reason: session.record.quarantineReason ?? reason,
    });
    try {
      await this.stopRuntime(session);
    } catch (error) {
      this.appendQuarantineReason(session, "runtime termination failed", error);
    }
  }

  private markQuarantined(session: SessionEntry, reason: string): void {
    this.setQuarantinedState(session, reason);
    this.persist(session);
    this.emitToActors(this.actorRecipients(session.record), {
      type: "session/quarantined",
      sessionId: session.record.sessionId,
      reason,
    });
    this.emitToActors(this.actorRecipients(session.record), {
      type: "session/statusChanged",
      sessionId: session.record.sessionId,
      status: "quarantined",
      reason,
    });
  }

  private setQuarantinedState(session: SessionEntry, reason: string): void {
    session.record.status = "quarantined";
    session.record.quarantineReason = reason;
    this.touchSession(session);
    session.recovery = this.buildRecoveryState(
      session.record,
      this.checkpointStore.read(session.record.sessionId),
    );
  }

  private appendQuarantineReason(
    session: SessionEntry,
    context: string,
    error: unknown,
  ): void {
    const detail = failureDetail(error);
    session.record.quarantineReason = `${session.record.quarantineReason ?? "session quarantined"}\n${context}: ${detail}`;
    this.touchSession(session);
    session.recovery.lastError = session.record.quarantineReason;
    try {
      this.persist(session);
    } catch (persistError) {
      session.record.quarantineReason += `\nquarantine persistence failed: ${failureDetail(
        persistError,
      )}`;
      session.recovery.lastError = session.record.quarantineReason;
    }
  }

  private async drainExecQueue(session: SessionEntry): Promise<void> {
    const runtime = session.runtime;
    if (!runtime || runtime.activeExec || runtime.queue.length === 0) return;
    while (
      session.runtime &&
      !session.runtime.activeExec &&
      session.runtime.queue.length > 0
    ) {
      const next = session.runtime.queue.shift();
      if (!next) return;
      try {
        await this.runExec(session, next, {
          emitActors: true,
          commitCheckpoint: session.record.durabilityMode === "checkpointed",
          checkpoint: this.checkpointStore.snapshot(session.record.sessionId),
        });
      } catch (error) {
        await this.failExecStartup(session, next, error);
        return;
      }
    }
  }

  private async runExec(
    session: SessionEntry,
    record: ExecRecord,
    options: InternalExecOptions,
  ): Promise<void> {
    const runtime = session.runtime;
    if (!runtime) {
      throw new Error(`session ${session.record.sessionId} is not live`);
    }
    session.record.status = "live_busy";
    this.touchSession(session);

    const startedAtMs = Math.max(Date.now(), record.submittedAtMs);
    record.status = "running";
    record.startedAtMs = startedAtMs;
    record.finishedAtMs = undefined;
    record.durationMs = undefined;

    const prepared = this.adapter(session).prepareExec({
      rootDir: this.historyStore.execBundlesDir,
      sessionId: session.record.sessionId,
      execId: record.execId,
      code: record.code,
      durabilityMode: session.record.durabilityMode,
      checkpoint: options.checkpoint,
    });
    const active: ActiveExec = {
      record,
      emitActors: options.emitActors,
      commitCheckpoint: options.commitCheckpoint,
      seq: 0,
      collector: prepared.collector,
      decoder: new TextDecoder(),
      capture: new ExecOutputCapture(record, this.adapter(session).runtimeId),
      completion: Promise.resolve(),
      resolveCompletion: () => undefined,
      dispose: prepared.dispose,
    };
    active.completion = new Promise<void>((resolve) => {
      active.resolveCompletion = resolve;
    });
    runtime.activeExec = active;
    this.persist(session);

    if (options.emitActors) {
      this.emitToActors(this.actorRecipients(session.record), {
        type: "exec/started",
        sessionId: session.record.sessionId,
        execId: record.execId,
        startedAtMs,
      });
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/statusChanged",
        sessionId: session.record.sessionId,
        status: "live_busy",
      });
    }

    await this.transport(session).write(runtime.handle, prepared.submitText);
    await active.completion;
    this.disposeActive(active);
    if (!options.emitActors && execFailed(record)) {
      const message =
        record.messages.find((entry) => entry.kind === "error")?.text ??
        "internal exec failed";
      throw new Error(message);
    }
  }

  private onBrokerChunk(session: SessionEntry, chunk: Uint8Array): void {
    const active = session.runtime?.activeExec;
    try {
      this.processBrokerChunk(session, chunk);
    } catch (error) {
      this.containRuntimeFailure(
        session,
        active,
        `runtime output processing failed: ${failureDetail(error)}`,
      );
    }
  }

  private onRuntimeExit(
    session: SessionEntry,
    handle: TransportSessionHandle,
    error: Error,
  ): void {
    if (session.runtime?.handle !== handle) return;
    this.containRuntimeFailure(
      session,
      session.runtime.activeExec,
      `runtime process exited: ${failureDetail(error)}`,
    );
  }

  private processBrokerChunk(session: SessionEntry, chunk: Uint8Array): void {
    const active = session.runtime?.activeExec;
    if (!active || !session.runtime) return;

    const actorIds = this.actorRecipients(session.record);
    if (active.emitActors && actorIds.length > 0) {
      for (
        let offset = 0;
        offset < chunk.byteLength;
        offset += PTY_DELTA_MAX_BYTES
      ) {
        active.seq += 1;
        this.emitToActors(actorIds, {
          type: "exec/ptyDelta",
          sessionId: session.record.sessionId,
          execId: active.record.execId,
          seq: active.seq,
          channel: "pty",
          dataBase64: Buffer.from(
            chunk.subarray(offset, offset + PTY_DELTA_MAX_BYTES),
          ).toString("base64"),
        });
      }
    }

    const text = active.decoder.decode(chunk, { stream: true });
    const parsed = active.collector.push(text);
    const messages = active.capture.consume(parsed.envelopes);
    if (active.emitActors) {
      for (const message of messages) {
        this.emitToActors(
          actorIds,
          execMessageEvent(
            session.record.sessionId,
            active.record.execId,
            message,
          ),
        );
      }
    }

    if (!parsed.done) return;

    const { capture } = active;
    const finishedAtMs = execTimestampAtOrAfterHistory(
      active.record,
      Date.now(),
    );
    finishExec(active.record, capture.completionStatus, finishedAtMs);
    if (capture.completionStatus === "interrupted") {
      active.record.interruptionReason = "controller_request";
    }
    if (active.commitCheckpoint && capture.completionStatus !== "interrupted") {
      const checkpointFailure = this.settleCheckpointOutcome(session, active);
      if (checkpointFailure) {
        capture.completionStatus = "error";
        active.record.status = "error";
        const message = appendExecMessage(
          active.record,
          "error",
          checkpointFailure,
        );
        if (active.emitActors) {
          this.emitToActors(
            actorIds,
            execMessageEvent(
              session.record.sessionId,
              active.record.execId,
              message,
            ),
          );
        }
      }
    }
    this.touchSession(session, finishedAtMs);
    if (session.runtime?.activeExec?.record.execId === active.record.execId) {
      session.runtime.activeExec = undefined;
    }
    if (session.record.status !== "quarantined") {
      session.record.status = session.runtime
        ? "live_idle"
        : session.record.status;
    }
    this.persist(session);
    if (active.emitActors) {
      this.emitToActors(
        actorIds,
        execFinishedEvent(session.record.sessionId, active.record),
      );
      this.emitToActors(actorIds, {
        type: "session/statusChanged",
        sessionId: session.record.sessionId,
        status: session.record.status,
      });
    }
    this.disposeActive(active);
    if (session.record.status === "quarantined") {
      void this.stopRuntime(session).catch((error) => {
        this.appendQuarantineReason(
          session,
          "runtime termination failed",
          error,
        );
      });
    }
    active.resolveCompletion();
  }

  private containRuntimeFailure(
    session: SessionEntry,
    active: ActiveExec | undefined,
    reason: string,
  ): void {
    if (!session.runtime) return;
    let message: ExecMessageRecord | undefined;
    if (active) {
      active.capture.completionStatus = "error";
      finishExec(
        active.record,
        "error",
        execTimestampAtOrAfterHistory(active.record, Date.now()),
      );
      message = appendExecMessage(active.record, "error", reason);
      session.runtime.activeExec = undefined;
    }
    this.terminalizeRuntimeExecs(session, "runtime_stopped", false);
    this.setQuarantinedState(session, reason);
    try {
      this.persist(session);
    } catch (persistError) {
      session.record.quarantineReason = `${reason}\nquarantine persistence failed: ${failureDetail(
        persistError,
      )}`;
      session.recovery.lastError = session.record.quarantineReason;
    }
    const runtime = session.runtime;
    try {
      runtime.unsubscribe();
    } catch (unsubscribeError) {
      this.appendQuarantineReason(
        session,
        "runtime unsubscribe failed",
        unsubscribeError,
      );
    }
    void this.transport(session)
      .terminate(runtime.handle)
      .then(
        () => {
          if (session.runtime === runtime) session.runtime = undefined;
        },
        (terminateError) => {
          this.appendQuarantineReason(
            session,
            "runtime termination failed",
            terminateError,
          );
        },
      );
    const actorIds = this.actorRecipients(session.record);
    if (active?.emitActors && message) {
      this.emitToActors(
        actorIds,
        execMessageEvent(
          session.record.sessionId,
          active.record.execId,
          message,
        ),
      );
      this.emitToActors(
        actorIds,
        execFinishedEvent(session.record.sessionId, active.record),
      );
    }
    this.emitToActors(actorIds, {
      type: "session/quarantined",
      sessionId: session.record.sessionId,
      reason: session.record.quarantineReason ?? reason,
    });
    this.emitToActors(actorIds, {
      type: "session/statusChanged",
      sessionId: session.record.sessionId,
      status: "quarantined",
      reason: session.record.quarantineReason ?? reason,
    });
    if (active) {
      this.disposeActive(active);
      active.resolveCompletion();
    }
  }

  /**
   * A checkpointed exec must end with exactly one valid commit, or one
   * preservation after an error. Returns the failure reason, if any, after
   * quarantining the session.
   */
  private settleCheckpointOutcome(
    session: SessionEntry,
    active: ActiveExec,
  ): string | undefined {
    const { capture } = active;
    const runtimeId = this.adapter(session).runtimeId;
    if (capture.checkpointOutcome === "invalid") {
      return this.failCheckpointCommit(
        session,
        `runtime ${runtimeId} emitted conflicting checkpoint outcomes for one exec`,
        active.record.execId,
      );
    }
    if (capture.checkpointOutcome === "preserved") {
      return capture.completionStatus === "error"
        ? undefined
        : this.failCheckpointCommit(
            session,
            `runtime ${runtimeId} preserved a checkpoint after a successful exec`,
            active.record.execId,
          );
    }
    if (capture.checkpointOutcome !== "commit" || !capture.checkpointCommit) {
      return this.failCheckpointCommit(
        session,
        `runtime ${runtimeId} completed a checkpointed exec without emitting a checkpoint outcome; exactly one valid commit or error preservation is required`,
        active.record.execId,
      );
    }
    return this.commitCheckpointCommit(
      session,
      capture.checkpointCommit,
      active.record.execId,
    );
  }

  private commitCheckpointCommit(
    session: SessionEntry,
    checkpointCommit: RuntimeCheckpointCommit,
    execId?: string,
  ): string | undefined {
    let checkpoint: SessionCheckpoint;
    try {
      const adapter = this.adapter(session);
      if (checkpointCommit.runtimeId !== adapter.runtimeId) {
        throw new Error(
          `runtime ${adapter.runtimeId} emitted a ${checkpointCommit.runtimeId} checkpoint`,
        );
      }
      assertRuntimeCheckpointCompatible(adapter, checkpointCommit);
      checkpoint = this.checkpointStore.writeCommit(
        session.record.sessionId,
        checkpointCommit,
      );
    } catch (error) {
      const message = failureDetail(error);
      return this.failCheckpointCommit(session, message, execId);
    }

    try {
      this.afterCheckpointCommitted(session, checkpoint);
      return undefined;
    } catch (error) {
      const detail = failureDetail(error);
      const reason = `checkpoint ${checkpoint.revision} committed, but its session metadata could not be persisted: ${detail}`;
      this.markQuarantined(session, reason);
      return reason;
    }
  }

  private failCheckpointCommit(
    session: SessionEntry,
    reason: string,
    execId?: string,
  ): string {
    this.emitToActors(this.actorRecipients(session.record), {
      type: "session/checkpointFailed",
      sessionId: session.record.sessionId,
      execId,
      reason,
    });
    this.markQuarantined(session, reason);
    return reason;
  }

  private commitCheckpointValue(
    session: SessionEntry,
    checkpointValue: unknown,
    runtimeId = this.adapter(session).runtimeId,
  ): void {
    const checkpoint = this.checkpointStore.writeCommit(
      session.record.sessionId,
      {
        runtimeId,
        codecId: "json-v1",
        codecVersion: 1,
        payloadKind: "json-inline",
        inlineJson: checkpointValue,
        compatibility: {},
      },
    );
    this.afterCheckpointCommitted(session, checkpoint);
  }

  private afterCheckpointCommitted(
    session: SessionEntry,
    checkpoint: SessionCheckpoint,
  ): void {
    session.record.checkpointRevision = checkpoint.revision;
    session.record.checkpointUpdatedAtMs = checkpoint.updatedAtMs;
    session.recovery = this.buildRecoveryState(session.record, checkpoint);
    this.touchSession(session, checkpoint.updatedAtMs);
    try {
      this.persist(session);
    } finally {
      // The checkpoint manifest is authoritative before catalog/history are
      // projected. Even if that projection fails, observers must not be told
      // that an already-committed checkpoint failed.
      this.emitToActors(this.actorRecipients(session.record), {
        type: "session/checkpointCommitted",
        sessionId: session.record.sessionId,
        checkpointRevision: checkpoint.revision,
        codecId: checkpoint.codecId,
        byteLength: checkpoint.byteLength,
      });
    }
  }

  private finalizeInterruptedExec(session: SessionEntry, execId: string): void {
    const active = session.runtime?.activeExec;
    if (!active || active.record.execId !== execId || !session.runtime) return;
    const finishedAtMs = execTimestampAtOrAfterHistory(
      active.record,
      Date.now(),
    );
    active.capture.completionStatus = "interrupted";
    finishExec(active.record, "interrupted", finishedAtMs);
    active.record.interruptionReason = "controller_request";
    session.runtime.activeExec = undefined;
    this.touchSession(session, finishedAtMs);
    this.persist(session);
    if (active.emitActors) {
      this.emitToActors(
        this.actorRecipients(session.record),
        execFinishedEvent(session.record.sessionId, active.record),
      );
    }
    this.disposeActive(active);
    active.resolveCompletion();
  }

  private recordEvent(event: SessionEvent): void {
    const occurredAtMs = Date.now();
    this.serverEventLog.append(event, occurredAtMs);
    if ("sessionId" in event) {
      this.sessions.get(event.sessionId)?.eventLog.append(event, occurredAtMs);
    }
  }

  private async failExecStartup(
    session: SessionEntry,
    record: ExecRecord,
    error: unknown,
  ): Promise<void> {
    if (record.status !== "queued" && record.status !== "running") return;
    const observedAtMs = Date.now();
    const messageText = failureDetail(error);
    if (session.runtime?.activeExec?.record.execId === record.execId) {
      this.disposeActive(session.runtime.activeExec);
      session.runtime.activeExec.resolveCompletion();
      session.runtime.activeExec = undefined;
    }
    record.startedAtMs ??= Math.max(observedAtMs, record.submittedAtMs);
    const finishedAtMs = execTimestampAtOrAfterHistory(record, observedAtMs);
    this.touchSession(session, finishedAtMs);
    finishExec(record, "error", finishedAtMs);
    const message = appendExecMessage(record, "error", messageText);
    const actorIds = this.actorRecipients(session.record);
    this.emitToActors(
      actorIds,
      execMessageEvent(session.record.sessionId, record.execId, message),
    );
    this.emitToActors(
      actorIds,
      execFinishedEvent(session.record.sessionId, record),
    );
    await this.quarantineSession(
      session,
      `exec startup failed: ${messageText}`,
    );
  }

  private disposeActive(active: ActiveExec): void {
    const dispose = active.dispose;
    active.dispose = undefined;
    dispose?.();
  }

  private touchSession(session: SessionEntry, observedAtMs = Date.now()): void {
    session.record.updatedAtMs = Math.max(
      observedAtMs,
      session.record.createdAtMs,
      session.record.updatedAtMs,
      session.record.checkpointUpdatedAtMs ?? 0,
    );
  }
}

function cloneExecRecord(record: ExecRecord): ExecRecord {
  return {
    ...record,
    messages: record.messages.map((message) => ({ ...message })),
  };
}
