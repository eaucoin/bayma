import { expect, spyOn, test } from "bun:test";
import {
  CheckpointStore,
  ExecHistoryStore,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  type TransportSessionHandle,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

/** A transport whose runtimes collect their garbage, but for one that fails to. */
class CollectingTransport extends FakeTransport {
  readonly collected: string[] = [];
  failing?: string;

  readonly collectGarbage = async (
    handle: TransportSessionHandle,
    timeoutMs: number,
  ): Promise<void> => {
    if (handle.sessionId === this.failing)
      throw new Error("it did not answer its probe");
    this.collected.push(`${handle.sessionId} within ${timeoutMs} ms`);
  };
}

function managerOf(dir: string, transport: FakeTransport): SessionManager {
  return new SessionManager(
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
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Bun.sleep(0);
}

test("each session's runtime waiting at its prompt collects its garbage, and one running an exec is left as it is, as is one that fails to, said", async () => {
  await withTempDir(async (dir) => {
    const transport = new CollectingTransport(false);
    const manager = managerOf(dir, transport);
    const create = async (title: string) =>
      (
        await manager.createWithPolicy(
          "actor_1",
          title,
          dir,
          { durabilityMode: "ephemeral" },
          "controller",
        )
      ).sessionId;
    const idle = await create("idle");
    const busy = await create("busy");
    const failing = await create("failing");
    transport.failing = failing;
    await manager.submitExec(busy, "actor_1", "1");
    await settle();
    const reports: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        reports.push(String(chunk));
        return true;
      },
    );
    try {
      expect(await manager.collectGarbage()).toBe(1);
    } finally {
      stderr.mockRestore();
    }
    expect(transport.collected).toEqual([`${idle} within 5000 ms`]);
    expect(reports).toEqual([
      `bayma: session ${failing}'s bun runtime did not collect its garbage before the save: it did not answer its probe\n`,
    ]);
    transport.completeNext(busy);
    await settle();
  });
});

test("a runtime whose transport collects no garbage is left as it is", async () => {
  await withTempDir(async (dir) => {
    const manager = managerOf(dir, new FakeTransport());
    await manager.createWithPolicy(
      "actor_1",
      "idle",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    expect(await manager.collectGarbage()).toBe(0);
  });
});
