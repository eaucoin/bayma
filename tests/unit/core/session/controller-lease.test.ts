import { expect, test } from "bun:test";
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

test("exactly one controller may mutate a session while observers stay read-only", async () => {
  await withTempDir(async (dir) => {
    const manager = new SessionManager(
      new RuntimeRegistry([
        { adapter: bunAdapter, transport: new FakeTransport() },
      ]),
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

    expect(
      manager.attach(session.sessionId, "conn_b", "controller"),
    ).rejects.toThrow("controller lease already held");
    await manager.attach(session.sessionId, "conn_b", "observer");
    expect(
      manager.submitExec(session.sessionId, "conn_b", "1 + 1"),
    ).rejects.toThrow("write action requires controller lease");
    await manager.detach(session.sessionId, "conn_a");
    const rebound = await manager.attach(
      session.sessionId,
      "conn_b",
      "controller",
    );
    expect(rebound.controllerActorId).toBe("conn_b");
    expect(rebound.observerActorIds).not.toContain("conn_b");
    await expect(
      manager.attach(session.sessionId, "conn_b", "observer"),
    ).rejects.toThrow("controller actor cannot also attach as an observer");
  });
});
