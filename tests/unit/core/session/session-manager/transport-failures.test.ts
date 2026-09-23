import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import {
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  SessionManager,
  RUNTIME_OUTPUT_CAPTURE_POLICY,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import {
  FailingResizeTransport,
  FailingInterruptTransport,
  ExitingResizeTransport,
  ExitingInterruptTransport,
} from "../../../../support/session-fixture.ts";
import { withTempDir } from "../../../../support/temp.ts";

test("durable runtime output obeys shared byte and message ceilings", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      new SessionCatalogStore(dir),
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
    const created = await manager.create("actor_1", "bounded output", dir);
    const submitted = await manager.submitExec(
      created.sessionId,
      "actor_1",
      "42",
    );
    const marker = transport.pendingEventPrefix(created.sessionId);

    transport.emit(
      created.sessionId,
      `${marker}${JSON.stringify({ kind: "stdout", text: "😀".repeat(40_000) })}\n`,
    );
    for (
      let index = 1;
      index < RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessages;
      index += 1
    ) {
      transport.emit(
        created.sessionId,
        `${marker}${JSON.stringify({ kind: "stdout", text: "x" })}\n`,
      );
    }
    transport.emit(
      created.sessionId,
      `${marker}${JSON.stringify({ kind: "stdout", text: "discarded" })}\n`,
    );
    transport.completeNext(created.sessionId);
    await Bun.sleep(0);

    const exec = manager.exec(created.sessionId, submitted.execId);
    expect(exec.status).toBe("ok");
    expect(exec.messages).toHaveLength(
      RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessages + 1,
    );
    expect(exec.messages[0]?.text).toContain("Bayma truncated runtime message");
    expect(
      Buffer.byteLength(exec.messages[0]!.text, "utf8"),
    ).toBeLessThanOrEqual(RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessageBytes);
    expect(exec.messages.at(-1)?.text).toContain(
      "Bayma stopped retaining runtime output",
    );
    expect(exec.messages.some((message) => message.text === "discarded")).toBe(
      false,
    );
  });
});

test("raw PTY events are chunked and retained under a byte ceiling", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      new SessionCatalogStore(dir),
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
    const created = await manager.create("actor_1", "bounded PTY", dir);
    await manager.submitExec(created.sessionId, "actor_1", "42");

    transport.emit(created.sessionId, "x".repeat(5 * 1024 * 1024));

    const ptyEvents = manager
      .events(created.sessionId)
      .map((record) => record.event)
      .filter((event) => event.type === "exec/ptyDelta");
    expect(ptyEvents.length).toBeGreaterThan(0);
    expect(
      ptyEvents.every(
        (event) =>
          Buffer.from(event.dataBase64, "base64").byteLength <= 64 * 1024,
      ),
    ).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(manager.events(created.sessionId))),
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
  });
});

test("resize and interrupt transport failures quarantine their sessions", async () => {
  await withTempDir(async (dir) => {
    const createManager = (transport: FakeTransport) =>
      new SessionManager(
        new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
        new SessionCatalogStore(dir),
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

    const resizeTransport = new FailingResizeTransport();
    const resizeManager = createManager(resizeTransport);
    const resizeSession = await resizeManager.create(
      "actor_resize",
      "resize failure",
      dir,
    );
    await expect(
      resizeManager.resize(resizeSession.sessionId, "actor_resize", 120, 40),
    ).rejects.toThrow("simulated runtime resize failure");
    expect(resizeManager.detail(resizeSession.sessionId).status).toBe(
      "quarantined",
    );
    expect(resizeTransport.sessions.size).toBe(0);
    await resizeManager.shutdown();

    const interruptTransport = new FailingInterruptTransport();
    const interruptManager = createManager(interruptTransport);
    const interruptSession = await interruptManager.create(
      "actor_interrupt",
      "interrupt failure",
      dir,
    );
    const submitted = await interruptManager.submitExec(
      interruptSession.sessionId,
      "actor_interrupt",
      "await Bun.sleep(60_000)",
    );
    await expect(
      interruptManager.interrupt(interruptSession.sessionId, "actor_interrupt"),
    ).rejects.toThrow("simulated runtime interrupt failure");
    expect(interruptManager.detail(interruptSession.sessionId).status).toBe(
      "quarantined",
    );
    expect(
      interruptManager.exec(interruptSession.sessionId, submitted.execId),
    ).toEqual(
      expect.objectContaining({
        status: "interrupted",
        interruptionReason: "runtime_stopped",
      }),
    );
    expect(interruptTransport.sessions.size).toBe(0);
    await interruptManager.shutdown();
  });
});

test("in-flight transport exits cannot overwrite quarantine", async () => {
  await withTempDir(async (dir) => {
    const createManager = (transport: FakeTransport) =>
      new SessionManager(
        new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
        new SessionCatalogStore(dir),
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

    const resizeManager = createManager(new ExitingResizeTransport());
    const resizeSession = await resizeManager.create(
      "actor_resize_exit",
      "resize exit",
      dir,
    );
    await expect(
      resizeManager.resize(
        resizeSession.sessionId,
        "actor_resize_exit",
        120,
        40,
      ),
    ).rejects.toThrow("runtime exited during resize");
    expect(resizeManager.detail(resizeSession.sessionId).status).toBe(
      "quarantined",
    );
    await resizeManager.shutdown();

    const interruptManager = createManager(new ExitingInterruptTransport());
    const interruptSession = await interruptManager.create(
      "actor_interrupt_exit",
      "interrupt exit",
      dir,
    );
    const submitted = await interruptManager.submitExec(
      interruptSession.sessionId,
      "actor_interrupt_exit",
      "await Bun.sleep(60_000)",
    );
    await expect(
      interruptManager.interrupt(
        interruptSession.sessionId,
        "actor_interrupt_exit",
      ),
    ).rejects.toThrow("runtime exited during interrupt");
    expect(interruptManager.detail(interruptSession.sessionId).status).toBe(
      "quarantined",
    );
    expect(
      interruptManager.exec(interruptSession.sessionId, submitted.execId),
    ).toEqual(expect.objectContaining({ status: "error" }));
    await interruptManager.shutdown();
  });
});
