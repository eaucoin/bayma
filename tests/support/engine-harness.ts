import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createEngine,
  type Engine,
  type ExecRecord,
  type SessionCreatePolicy,
  type SessionEvent,
  type SessionManager,
  type SessionRole,
  type SessionSummary,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";

// An in-process engine with the Bun adapter, driven the way the MCP layer
// drives it: through SessionManager, with one actor id per connected client.

const DEFAULT_EVENT_TIMEOUT_MS = 5_000;
const EXEC_STATUSES_SETTLED = new Set(["ok", "error", "interrupted"]);

export interface EngineHarnessOptions {
  maxSessions?: number;
  warnUsagePercent?: number;
  stateDir?: string;
  resolveCreatePolicy?: (request: {
    actorId: string;
    title: string;
    cwd: string;
    role: SessionRole;
  }) => SessionCreatePolicy;
}

interface EventWaiter {
  predicate: (event: SessionEvent) => boolean;
  resolve: (event: SessionEvent) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** One connected client: an actor id plus the events delivered to it. */
export class EngineActor {
  readonly actorId = `actor_${randomUUID().slice(0, 8)}`;
  readonly events: SessionEvent[] = [];
  private readonly waiters = new Set<EventWaiter>();
  private released = false;

  private readonly harness: EngineHarness;

  constructor(harness: EngineHarness) {
    this.harness = harness;
  }

  get manager(): SessionManager {
    return this.harness.manager;
  }

  create(title: string, cwd = process.cwd(), role: SessionRole = "controller") {
    return this.manager.create(this.actorId, title, cwd, role);
  }

  attach(sessionId: string, role: SessionRole): Promise<SessionSummary> {
    return this.manager.attach(sessionId, this.actorId, role);
  }

  detach(sessionId: string): Promise<SessionSummary> {
    return this.manager.detach(sessionId, this.actorId);
  }

  submit(sessionId: string, code: string): Promise<{ execId: string }> {
    return this.manager.submitExec(sessionId, this.actorId, code);
  }

  interrupt(sessionId: string): Promise<SessionSummary> {
    return this.manager.interrupt(sessionId, this.actorId);
  }

  resize(sessionId: string, cols: number, rows: number) {
    return this.manager.resize(sessionId, this.actorId, cols, rows);
  }

  close(sessionId: string): Promise<SessionSummary> {
    return this.manager.close(sessionId, this.actorId);
  }

  /** Submit code and wait for its `exec/finished` event. */
  async run(
    sessionId: string,
    code: string,
    timeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
  ): Promise<ExecRecord> {
    const { execId } = await this.submit(sessionId, code);
    return this.waitForExec(sessionId, execId, timeoutMs);
  }

  async waitForExec(
    sessionId: string,
    execId: string,
    timeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
  ): Promise<ExecRecord> {
    await this.waitForEvent(
      (event) => event.type === "exec/finished" && event.execId === execId,
      timeoutMs,
    );
    const record = this.manager.exec(sessionId, execId);
    if (!EXEC_STATUSES_SETTLED.has(record.status)) {
      throw new Error(`exec ${execId} finished with status ${record.status}`);
    }
    return record;
  }

  waitForEvent(
    predicate: (event: SessionEvent) => boolean,
    timeoutMs = DEFAULT_EVENT_TIMEOUT_MS,
  ): Promise<SessionEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<SessionEvent>((resolve, reject) => {
      const waiter: EventWaiter = {
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("timed out waiting for session event"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  deliver(event: SessionEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(event)) {
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.harness.releaseActor(this);
  }
}

export class EngineHarness {
  private readonly actors = new Map<string, EngineActor>();
  private stopped = false;

  readonly engine: Engine;
  readonly stateDir: string;
  private readonly root: string;

  private constructor(engine: Engine, stateDir: string, root: string) {
    this.engine = engine;
    this.stateDir = stateDir;
    this.root = root;
  }

  static async launch(
    options: EngineHarnessOptions = {},
  ): Promise<EngineHarness> {
    const root = mkdtempSync(join(tmpdir(), "bayma-engine-"));
    const stateDir = resolve(options.stateDir ?? join(root, "state"));
    let harness: EngineHarness | undefined;
    const engine = await createEngine(
      [bunAdapter],
      {
        stateDir,
        maxSessions: options.maxSessions ?? 8,
        warnUsagePercent: options.warnUsagePercent ?? 75,
        defaultCols: 120,
        defaultRows: 40,
        resolveCreatePolicy: options.resolveCreatePolicy,
      },
      ({ actorIds, event }) => {
        for (const actorId of actorIds)
          harness?.actors.get(actorId)?.deliver(event);
      },
    );
    harness = new EngineHarness(engine, stateDir, root);
    return harness;
  }

  get manager(): SessionManager {
    return this.engine.manager;
  }

  actor(): EngineActor {
    const actor = new EngineActor(this);
    this.actors.set(actor.actorId, actor);
    return actor;
  }

  async releaseActor(actor: EngineActor): Promise<void> {
    this.actors.delete(actor.actorId);
    await this.manager.releaseActor(actor.actorId);
  }

  /** Shut the engine down but keep the state directory (restart scenarios). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const actor of [...this.actors.values()]) await actor.release();
    await this.engine.shutdown();
  }

  async close(): Promise<void> {
    await this.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}

export async function withEngine<T>(
  fn: (context: { harness: EngineHarness; actor: EngineActor }) => Promise<T>,
  options: EngineHarnessOptions = {},
): Promise<T> {
  const harness = await EngineHarness.launch(options);
  try {
    return await fn({ harness, actor: harness.actor() });
  } finally {
    await harness.close();
  }
}
