import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  CheckpointStore,
  ExecHistoryStore,
  RuntimeRegistry,
  ServerStopping,
  SessionCatalogStore,
  SessionManager,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

// What the session manager reports to the server's operator, on stderr, is
// not this file's concern.
let restoreStderr: () => void;

beforeEach(() => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  restoreStderr = () => stderr.mockRestore();
});

afterEach(() => restoreStderr());

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Bun.sleep(0);
}

test("a held stop takes no new session and no new exec, and those running or queued carry on", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
      new SessionCatalogStore(dir),
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
        processSnapshotter: null,
      },
      () => undefined,
    );
    const { sessionId } = await manager.createWithPolicy(
      "actor_1",
      "held",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    const running = await manager.submitExec(sessionId, "actor_1", "1");
    const queued = await manager.submitExec(sessionId, "actor_1", "2");
    await settle();
    manager.holdStop("the server is stopping");
    await expect(
      manager.submitExec(sessionId, "actor_1", "3"),
    ).rejects.toBeInstanceOf(ServerStopping);
    await expect(
      manager.createWithPolicy(
        "actor_1",
        "new",
        dir,
        { durabilityMode: "ephemeral" },
        "controller",
      ),
    ).rejects.toBeInstanceOf(ServerStopping);
    transport.completeNext(sessionId);
    await settle();
    transport.completeNext(sessionId);
    await settle();
    expect(
      [running, queued].map(
        ({ execId }) => manager.exec(sessionId, execId).status,
      ),
    ).toEqual(["ok", "ok"]);
    manager.releaseStop();
    await manager.submitExec(sessionId, "actor_1", "4");
  });
});
