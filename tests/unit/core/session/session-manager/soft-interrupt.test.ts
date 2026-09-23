import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "bun:test";
import {
  type StartSessionInput,
  type RuntimeTransport,
  type TransportChunkListener,
  type TransportSessionHandle,
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  SessionManager,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { withTempDir } from "../../../../support/temp.ts";

interface RecycleSession {
  handle: TransportSessionHandle;
  listeners: Set<TransportChunkListener>;
  promptCount: number;
}

function extractLoadPath(command: string): string | null {
  const line = command
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(".load "));
  return line ? line.slice(".load ".length) : null;
}

function markerFromFile(path: string): string {
  const content = readFileSync(path, "utf8");
  const match = content.match(/"(__BAYMA_EVENT_[^"]+)"/);
  if (!match) {
    throw new Error(`failed to parse marker from ${path}`);
  }
  return match[1];
}

class RecycleTransport implements RuntimeTransport {
  private readonly sessions = new Map<string, RecycleSession>();

  async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    const handle: TransportSessionHandle = {
      sessionId: input.sessionId,
      platformId: "recycle-fake",
      pid: -1,
      cols: input.cols,
      rows: input.rows,
    };
    this.sessions.set(input.sessionId, {
      handle,
      listeners: new Set(),
      promptCount: 1,
    });
    return handle;
  }

  async write(
    handle: TransportSessionHandle,
    data: Uint8Array | string,
  ): Promise<void> {
    this.requireSession(handle.sessionId);
    const text =
      typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    if (text.trim().length === 0) {
      this.emitPrompt(handle.sessionId);
      return;
    }

    const loadPath = extractLoadPath(text);
    if (!loadPath) return;

    const fileText = readFileSync(loadPath, "utf8");
    const eventPrefix = markerFromFile(loadPath);
    if (fileText.includes("await new Promise(() => {})")) {
      return;
    }
    if (fileText.includes("keep + 1")) {
      this.emit(
        handle.sessionId,
        `${eventPrefix}{"kind":"result","text":"42"}\n`,
      );
    }
    if (fileText.includes('const __baymaDurabilityMode = "checkpointed"')) {
      this.emit(
        handle.sessionId,
        `${eventPrefix}${JSON.stringify({
          kind: "checkpoint",
          checkpoint: {
            runtimeId: "bun",
            codecId: "json-v1",
            codecVersion: 1,
            payloadKind: "json-inline",
            inlineJson: { keep: 41 },
            compatibility: {},
          },
        })}\n`,
      );
    }
    this.emit(handle.sessionId, `${eventPrefix}{"kind":"done"}\n`);
    this.emitPrompt(handle.sessionId);
  }

  async resize(
    handle: TransportSessionHandle,
    size: { cols: number; rows: number },
  ): Promise<void> {
    const session = this.requireSession(handle.sessionId);
    session.handle.cols = size.cols;
    session.handle.rows = size.rows;
  }

  async subscribe(
    handle: TransportSessionHandle,
    onChunk: TransportChunkListener,
  ): Promise<() => void> {
    const session = this.requireSession(handle.sessionId);
    session.listeners.add(onChunk);
    return () => {
      session.listeners.delete(onChunk);
    };
  }

  async captureSnapshot(): Promise<string> {
    return "";
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

  async interrupt(): Promise<"soft" | "recycle"> {
    return "recycle";
  }

  async terminate(handle: TransportSessionHandle): Promise<void> {
    this.sessions.delete(handle.sessionId);
  }

  async shutdown(): Promise<void> {
    this.sessions.clear();
  }

  private emit(sessionId: string, text: string): void {
    const session = this.requireSession(sessionId);
    const chunk = new Uint8Array(Buffer.from(text));
    for (const listener of session.listeners) {
      listener(chunk);
    }
  }

  private emitPrompt(sessionId: string): void {
    const session = this.requireSession(sessionId);
    session.promptCount += 1;
    this.emit(sessionId, "> \n");
  }

  private requireSession(sessionId: string): RecycleSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown fake session ${sessionId}`);
    }
    return session;
  }
}

test("a soft interrupt falls back to a checkpoint recycle", async () => {
  await withTempDir(async (dir) => {
    const transport = new RecycleTransport();
    const catalogStore = new SessionCatalogStore(dir);
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      catalogStore,
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );

    const session = await manager.createWithPolicy(
      "actor_1",
      "interrupt",
      dir,
      {
        durabilityMode: "checkpointed",
        bootstrapCode: "globalThis.keep = globalThis.$checkpoint?.keep ?? 0;",
        initialCheckpoint: { keep: 41 },
      },
      "controller",
    );

    const hanging = await manager.submitExec(
      session.sessionId,
      "actor_1",
      "await new Promise(() => {})",
    );
    await sleep(25);
    const queued = await manager.submitExec(
      session.sessionId,
      "actor_1",
      "keep + 1",
    );

    const before = catalogStore.read(session.sessionId)?.runtimeGeneration ?? 0;
    const interrupted = await manager.interrupt(session.sessionId, "actor_1");
    const hangExec = manager.exec(session.sessionId, hanging.execId);
    const after = catalogStore.read(session.sessionId)?.runtimeGeneration ?? 0;

    expect(hangExec.status).toBe("interrupted");
    expect(hangExec.interruptionReason).toBe("controller_request");
    expect(after).toBeGreaterThan(before);
    expect(interrupted.status).toBe("live_idle");

    const queuedDeadline = Date.now() + 1_000;
    while (Date.now() < queuedDeadline) {
      const queuedExec = manager.exec(session.sessionId, queued.execId);
      if (queuedExec.status === "ok") {
        expect(
          queuedExec.messages.some(
            (message) =>
              message.kind === "result" && message.text.includes("42"),
          ),
        ).toBe(true);
        break;
      }
      await sleep(10);
    }
    expect(manager.exec(session.sessionId, queued.execId).status).toBe("ok");

    const afterExec = await manager.submitExec(
      session.sessionId,
      "actor_1",
      "keep + 1",
    );
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const exec = manager.exec(session.sessionId, afterExec.execId);
      if (exec.status === "ok") {
        expect(
          exec.messages.some(
            (message) =>
              message.kind === "result" && message.text.includes("42"),
          ),
        ).toBe(true);
        return;
      }
      await sleep(10);
    }

    throw new Error(`timed out waiting for ${afterExec.execId} to finish`);
  });
});
