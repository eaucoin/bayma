import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  type StartSessionInput,
  type TransportSessionHandle,
  SessionCatalogStore,
} from "@bayma/core";
import { FakeTransport } from "./fake-transport.ts";

// Transports and stores that fail or misbehave in one specific way, shared by
// the session-manager unit tests.

export class CountingTransport extends FakeTransport {
  startCount = 0;

  override async startSession(
    input: StartSessionInput,
  ): Promise<TransportSessionHandle> {
    this.startCount += 1;
    return super.startSession(input);
  }
}

export class CountingWritesTransport extends FakeTransport {
  writeCount = 0;

  override async write(
    handle: TransportSessionHandle,
    data: Uint8Array | string,
  ): Promise<void> {
    this.writeCount += 1;
    await super.write(handle, data);
  }
}

export class FailingCatalogStore extends SessionCatalogStore {
  failNextWrite = false;

  override write(entry: Parameters<SessionCatalogStore["write"]>[0]): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated catalog write crash");
    }
    super.write(entry);
  }
}

export class FailingRemovalCatalogStore extends SessionCatalogStore {
  failNextRemove = false;

  override remove(sessionId: string): void {
    if (this.failNextRemove) {
      this.failNextRemove = false;
      throw new Error("simulated catalog removal crash");
    }
    super.remove(sessionId);
  }
}

export class FailingPromptTransport extends FakeTransport {
  override async waitForInitialPrompt(): Promise<void> {
    throw new Error("simulated prompt startup failure");
  }
}

export class FailingWriteTransport extends FakeTransport {
  override async write(): Promise<void> {
    throw new Error("simulated runtime write failure");
  }
}

export class FailingResizeTransport extends FakeTransport {
  override async resize(): Promise<void> {
    throw new Error("simulated runtime resize failure");
  }
}

export class FailingInterruptTransport extends FakeTransport {
  constructor() {
    super(false);
  }

  override async interrupt(): Promise<"soft" | "recycle"> {
    throw new Error("simulated runtime interrupt failure");
  }
}

export class ExitingResizeTransport extends FakeTransport {
  override async resize(handle: TransportSessionHandle): Promise<void> {
    this.exit(handle.sessionId, new Error("runtime exited during resize"));
  }
}

export class ExitingInterruptTransport extends FakeTransport {
  constructor() {
    super(false);
  }

  override async interrupt(
    handle: TransportSessionHandle,
  ): Promise<"soft" | "recycle"> {
    this.exit(handle.sessionId, new Error("runtime exited during interrupt"));
    return "soft";
  }
}

export class FailingBootstrapTransport extends FakeTransport {
  constructor() {
    super(false);
  }

  override async write(
    handle: TransportSessionHandle,
    data: Uint8Array | string,
  ): Promise<void> {
    await super.write(handle, data);
    const text =
      typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const loadLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(".load "));
    if (!loadLine) return;
    const source = readFileSync(loadLine.slice(".load ".length), "utf8");
    const marker = source.match(/"(__BAYMA_EVENT_[^"]+)"/)?.[1];
    if (!marker) throw new Error("failed to find exec marker");
    this.emit(
      handle.sessionId,
      `${marker}${JSON.stringify({ kind: "error", text: "simulated bootstrap failure" })}\n`,
    );
    this.emit(
      handle.sessionId,
      `${marker}${JSON.stringify({ kind: "done" })}\n> \n`,
    );
  }
}

export class IncompatibleCheckpointTransport extends FakeTransport {
  constructor() {
    super(false);
  }

  override async write(
    handle: TransportSessionHandle,
    data: Uint8Array | string,
  ): Promise<void> {
    await super.write(handle, data);
    const text =
      typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const loadLine = text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(".load "));
    if (!loadLine) return;
    const source = readFileSync(loadLine.slice(".load ".length), "utf8");
    const marker = source.match(/"(__BAYMA_EVENT_[^"]+)"/)?.[1];
    if (!marker) throw new Error("failed to find exec marker");
    this.emit(
      handle.sessionId,
      `${marker}${JSON.stringify({
        kind: "checkpoint",
        checkpoint: {
          runtimeId: "python",
          codecId: "json-v1",
          codecVersion: 1,
          payloadKind: "json-inline",
          inlineJson: { incompatible: true },
          compatibility: {},
        },
      })}\n`,
    );
    this.emit(
      handle.sessionId,
      `${marker}${JSON.stringify({ kind: "done" })}\n> \n`,
    );
  }
}

export class ValidCheckpointTransport extends FakeTransport {
  constructor() {
    super(false);
  }

  completeWithCheckpoint(sessionId: string): void {
    const marker = this.pendingEventPrefix(sessionId);
    this.emit(
      sessionId,
      `${marker}${JSON.stringify({
        kind: "checkpoint",
        checkpoint: {
          runtimeId: "bun",
          codecId: "json-v1",
          codecVersion: 1,
          payloadKind: "json-inline",
          inlineJson: { committed: true },
          compatibility: {},
        },
      })}\n`,
    );
    this.emit(sessionId, `${marker}${JSON.stringify({ kind: "done" })}\n> \n`);
  }
}

export class PreservedCheckpointTransport extends FakeTransport {
  constructor() {
    super(false);
  }

  completeWithPreservation(sessionId: string, errored: boolean): void {
    const marker = this.pendingEventPrefix(sessionId);
    if (errored) {
      this.emit(
        sessionId,
        `${marker}${JSON.stringify({ kind: "error", text: "compile failed" })}\n`,
      );
    }
    this.emit(
      sessionId,
      `${marker}${JSON.stringify({ kind: "checkpoint-preserved" })}\n`,
    );
    this.requireSession(sessionId).writes.shift();
    this.emit(sessionId, `${marker}${JSON.stringify({ kind: "done" })}\n> \n`);
  }

  completeWithConflict(sessionId: string): void {
    const marker = this.pendingEventPrefix(sessionId);
    this.emit(
      sessionId,
      `${marker}${JSON.stringify({ kind: "checkpoint-preserved" })}\n`,
    );
    this.emit(
      sessionId,
      `${marker}${JSON.stringify({
        kind: "checkpoint",
        checkpoint: {
          runtimeId: "bun",
          codecId: "json-v1",
          codecVersion: 1,
          payloadKind: "json-inline",
          inlineJson: { answer: 99 },
          compatibility: {},
        },
      })}\n`,
    );
    this.requireSession(sessionId).writes.shift();
    this.emit(sessionId, `${marker}${JSON.stringify({ kind: "done" })}\n> \n`);
  }
}
