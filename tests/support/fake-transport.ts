import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import type {
  RuntimeTransport,
  StartSessionInput,
  TransportChunkListener,
  TransportExitListener,
  TransportSessionHandle,
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

  private completeFromWrite(sessionId: string, text: string): void {
    const paths = extractLoadPaths(text);
    if (paths.length < 1) return;
    const eventPrefix = markerFromFile(paths[0]);
    this.emit(sessionId, `${eventPrefix}{"kind":"done"}\n`);
    this.emitPrompt(sessionId);
  }

  private emitPrompt(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.promptCount += 1;
    this.emit(sessionId, "> \n");
  }
}
