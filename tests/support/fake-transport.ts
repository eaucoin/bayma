import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ProcessSnapshot,
  ProcessSnapshotter,
  RuntimeTransport,
  StartSessionInput,
  TransportChunkListener,
  TransportExitListener,
  TransportSessionHandle,
  TransportSnapshots,
} from "@bayma/core";

interface FakeTransportSession {
  handle: TransportSessionHandle;
  listeners: Set<TransportChunkListener>;
  exitListeners: Set<TransportExitListener>;
  writes: string[];
  cols: number;
  rows: number;
  promptCount: number;
}

function extractLoadPaths(command: string): string[] {
  return command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(".load "))
    .map((line) => line.slice(".load ".length));
}

function markerFromFile(path: string): string {
  const content = readFileSync(path, "utf8");
  const match = content.match(/"(__BAYMA_EVENT_[^"]+)"/);
  if (!match) {
    throw new Error(`failed to parse marker from ${path}`);
  }
  return match[1];
}

export class FakeTransport implements RuntimeTransport {
  readonly sessions = new Map<string, FakeTransportSession>();

  private readonly autoComplete: boolean;

  constructor(autoComplete = true) {
    this.autoComplete = autoComplete;
  }

  async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    const handle: TransportSessionHandle = {
      sessionId: input.sessionId,
      platformId: "fake",
      pid: -1,
      cols: input.cols,
      rows: input.rows,
    };
    this.sessions.set(input.sessionId, {
      handle,
      listeners: new Set(),
      exitListeners: new Set(),
      writes: [],
      cols: input.cols,
      rows: input.rows,
      promptCount: 1,
    });
    return handle;
  }

  async write(
    handle: TransportSessionHandle,
    data: Uint8Array | string,
  ): Promise<void> {
    const session = this.requireSession(handle.sessionId);
    const text =
      typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    session.writes.push(text);
    if (text.trim().length === 0) {
      this.emitPrompt(handle.sessionId);
      return;
    }
    if (this.autoComplete) {
      this.completeFromWrite(handle.sessionId, text);
    }
  }

  async resize(
    handle: TransportSessionHandle,
    size: { cols: number; rows: number },
  ): Promise<void> {
    const session = this.requireSession(handle.sessionId);
    session.cols = size.cols;
    session.rows = size.rows;
    session.handle.cols = size.cols;
    session.handle.rows = size.rows;
  }

  async subscribe(
    handle: TransportSessionHandle,
    onChunk: TransportChunkListener,
    onExit?: TransportExitListener,
  ): Promise<() => void> {
    const session = this.requireSession(handle.sessionId);
    session.listeners.add(onChunk);
    if (onExit) session.exitListeners.add(onExit);
    return () => {
      session.listeners.delete(onChunk);
      if (onExit) session.exitListeners.delete(onExit);
    };
  }

  async captureSnapshot(handle: TransportSessionHandle): Promise<string> {
    const session = this.requireSession(handle.sessionId);
    return session.writes.join("\n");
  }

  promptCount(handle: TransportSessionHandle): number {
    return this.requireSession(handle.sessionId).promptCount;
  }

  async waitForPrompt(
    handle: TransportSessionHandle,
    seenPromptCount: number,
  ): Promise<void> {
    const session = this.requireSession(handle.sessionId);
    if (session.promptCount > seenPromptCount) return;
    throw new Error(`timed out waiting for prompt for ${handle.sessionId}`);
  }

  async waitForInitialPrompt(): Promise<void> {}

  async interrupt(handle: TransportSessionHandle): Promise<"soft" | "recycle"> {
    this.emitPrompt(handle.sessionId);
    return "soft";
  }

  async terminate(handle: TransportSessionHandle): Promise<void> {
    this.sessions.delete(handle.sessionId);
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
  }

  emit(sessionId: string, text: string): void {
    const session = this.requireSession(sessionId);
    const chunk = new Uint8Array(Buffer.from(text));
    for (const listener of session.listeners) {
      listener(chunk);
    }
  }

  completeNext(sessionId: string): void {
    const session = this.requireSession(sessionId);
    const write = session.writes[0];
    if (!write) {
      throw new Error(`no pending write for ${sessionId}`);
    }
    this.completeFromWrite(sessionId, write);
    session.writes.shift();
  }

  pendingEventPrefix(sessionId: string): string {
    const write = this.requireSession(sessionId).writes[0];
    if (!write) {
      throw new Error(`no pending write for ${sessionId}`);
    }
    const [path] = extractLoadPaths(write);
    if (!path) {
      throw new Error(`pending write for ${sessionId} has no load path`);
    }
    return markerFromFile(path);
  }

  exit(sessionId: string, error = new Error("fake runtime exited")): void {
    const session = this.requireSession(sessionId);
    this.sessions.delete(sessionId);
    for (const listener of session.exitListeners) listener(error);
  }

  requireSession(sessionId: string): FakeTransportSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown fake session ${sessionId}`);
    }
    return session;
  }

  /** Complete the exec `text` submits, with `result` as its result if given. */
  protected completeFromWrite(
    sessionId: string,
    text: string,
    result?: string,
  ): void {
    const paths = extractLoadPaths(text);
    if (paths.length < 1) return;
    const eventPrefix = markerFromFile(paths[0]);
    if (result !== undefined) {
      this.emit(
        sessionId,
        `${eventPrefix}${JSON.stringify({ kind: "result", text: result })}\n`,
      );
    }
    this.emit(sessionId, `${eventPrefix}{"kind":"done"}\n`);
    this.emitPrompt(sessionId);
  }

  private emitPrompt(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.promptCount += 1;
    this.emit(sessionId, "> \n");
  }
}

/** A process snapshot this fake took, and where. */
export interface FakeSnapshotDump {
  sessionId: string;
  directory: string;
  snapshot: ProcessSnapshot;
}

/** The file a fake dump leaves in its snapshot directory. */
export const FAKE_SNAPSHOT_IMAGE = "images.img";

/**
 * A fake transport whose runtimes can be snapshotted, recording each dump and
 * restore. A dump ends its session, as CRIU's does; a restored session is
 * live again, answering the doctor probe its restore is checked with. Each
 * way a snapshot can fail is one field away.
 */
export class SnapshottingTransport extends FakeTransport {
  readonly dumps: FakeSnapshotDump[] = [];
  readonly restores: StartSessionInput[] = [];
  /** The sessions started fresh rather than restored. */
  readonly starts: StartSessionInput[] = [];
  /** Set to make dumps fail with this message. */
  snapshotFailure?: string;
  /** Set to make restores fail with this message. */
  restoreFailure?: string;
  /** Set to make every snapshot unrestorable, for this reason. */
  unrestorable?: string;
  /** What a restored runtime answers its doctor probe with. */
  probeAnswer = "42";

  private readonly awaitingProbe = new Set<string>();

  readonly snapshots: TransportSnapshots = {
    snapshot: (handle, directory) => this.snapshot(handle, directory),
    restore: (input, snapshot, directory) =>
      this.restore(input, snapshot, directory),
    unrestorableReason: () => this.unrestorable,
  };

  override async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    this.starts.push(input);
    return super.startSession(input);
  }

  protected override completeFromWrite(sessionId: string, text: string): void {
    if (this.awaitingProbe.delete(sessionId)) {
      super.completeFromWrite(sessionId, text, this.probeAnswer);
      return;
    }
    super.completeFromWrite(sessionId, text);
  }

  private async snapshot(
    handle: TransportSessionHandle,
    directory: string,
  ): Promise<ProcessSnapshot> {
    this.requireSession(handle.sessionId);
    if (this.snapshotFailure) throw new Error(this.snapshotFailure);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, FAKE_SNAPSHOT_IMAGE), handle.sessionId);
    // Each dump's tree sits above the last one's, as PIDs climb.
    const pid = 4_000 + 100 * this.dumps.length;
    const snapshot: ProcessSnapshot = {
      pid,
      maxPid: pid + 42,
      stdio: ["pipe:[1]", "pipe:[2]", "pipe:[3]"],
      stdioFds: [0, 1, 2],
      bootId: "fake-boot",
      baymaVersion: "0.0.0-fake",
      createdAtMs: Date.now(),
    };
    this.sessions.delete(handle.sessionId);
    this.dumps.push({ sessionId: handle.sessionId, directory, snapshot });
    return snapshot;
  }

  private async restore(
    input: StartSessionInput,
    snapshot: ProcessSnapshot,
    directory: string,
  ): Promise<TransportSessionHandle> {
    this.restores.push(input);
    if (this.restoreFailure) throw new Error(this.restoreFailure);
    readFileSync(join(directory, FAKE_SNAPSHOT_IMAGE));
    const handle = await super.startSession(input);
    handle.pid = snapshot.pid;
    this.awaitingProbe.add(input.sessionId);
    return handle;
  }
}

/**
 * A snapshotter that only records the PIDs it is asked to reserve: the
 * session manager's one direct use of the environment's snapshotter.
 */
export class PidReservingSnapshotter implements ProcessSnapshotter {
  readonly advancedPast: number[] = [];

  advancePidsPast(pid: number): void {
    this.advancedPast.push(pid);
  }

  dump(): ProcessSnapshot {
    throw new Error("the session manager dumps through its transports");
  }

  restoreCommand(): { file: string; args: string[] } {
    throw new Error("the session manager restores through its transports");
  }

  restoredPid(): number | undefined {
    throw new Error("the session manager restores through its transports");
  }

  unrestorableReason(): string | undefined {
    throw new Error("the session manager asks its transports");
  }
}
