import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  SessionManager,
  SessionCatalogStore,
  ExecHistoryStore,
  CheckpointStore,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../support/fake-transport.ts";
import { withTempDir } from "../../../support/temp.ts";

test("the single-flight exec queue is FIFO", async () => {
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
    const session = await manager.create("conn_a", "title", dir, "controller");

    await manager.submitExec(session.sessionId, "conn_a", "1 + 1");
    await manager.submitExec(session.sessionId, "conn_a", "2 + 2");

    const fake = transport.requireSession(session.sessionId);
    expect(fake.writes).toHaveLength(1);
    const firstWrite = fake.writes[0];
    expect(firstWrite.startsWith(".load ")).toBe(true);

    transport.completeNext(session.sessionId);
    await sleep(10);

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0].startsWith(".load ")).toBe(true);
    expect(fake.writes[0]).not.toBe(firstWrite);
  });
});
