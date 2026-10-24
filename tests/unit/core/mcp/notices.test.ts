import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  CheckpointStore,
  createMcpApplication,
  createModelSurface,
  describeExecNotice,
  ExecHistoryStore,
  renderExecSnapshotText,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import {
  PidReservingSnapshotter,
  SnapshottingTransport,
} from "../../../support/fake-transport.ts";
import { withTempDir } from "../../../support/temp.ts";

// What the session manager reports to the server's operator, on stderr, is
// not this file's concern.
let restoreStderr: () => void;

beforeEach(() => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  restoreStderr = () => stderr.mockRestore();
});

afterEach(() => restoreStderr());

function managerFor(
  dir: string,
  transport: SnapshottingTransport,
  registry = new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
): SessionManager {
  return new SessionManager(
    registry,
    new SessionCatalogStore(dir),
    new ExecHistoryStore(dir),
    new CheckpointStore(dir),
    {
      maxSessions: 8,
      warnUsagePercent: 75,
      defaultCols: 80,
      defaultRows: 24,
      processSnapshotter: new PidReservingSnapshotter(),
    },
    () => undefined,
  );
}

test("a notice opens a snapshot's text, which is the notice alone without output", () => {
  const snapshot = {
    stdout_text: "",
    stderr_text: "",
    result_text: "42",
    error_text: "",
    notice: "bayma: back",
  };
  expect(renderExecSnapshotText(snapshot)).toBe("bayma: back\n42");
  expect(renderExecSnapshotText({ ...snapshot, result_text: "" })).toBe(
    "bayma: back",
  );
});

test("a sandbox's restore is told with when its snapshot was taken, and why its host stopped the sandbox where it said", () => {
  const notice = { returnedFrom: "sandbox_snapshot", snapshotAtMs: 0 } as const;
  expect(describeExecNotice(notice)).toBe(
    "bayma: this session came back whole with bayma's sandbox, restored from a snapshot taken at 1970-01-01T00:00:00.000Z; its live state is as it was then, but its network connections were closed.",
  );
  expect(
    describeExecNotice({
      ...notice,
      stopReason: "it ran out of its memory (4Gi)",
    }),
  ).toBe(
    "bayma: this session came back whole with bayma's sandbox, restored from a snapshot taken at 1970-01-01T00:00:00.000Z, after the sandbox was stopped as it ran out of its memory (4Gi); its live state is as it was then, so what ran in it since is gone, but its network connections were closed.",
  );
});

test("exec tells the model how its session came back, once", async () => {
  await withTempDir(async (dir) => {
    const stopped = managerFor(dir, new SnapshottingTransport());
    const { sessionId } = await stopped.createWithPolicy(
      "actor",
      "notice",
      dir,
      { durabilityMode: "checkpointed" },
      "controller",
    );
    await stopped.shutdown();

    const transport = new SnapshottingTransport();
    transport.checkpointValue = {};
    const registry = new RuntimeRegistry([{ adapter: bunAdapter, transport }]);
    const manager = managerFor(dir, transport, registry);
    await manager.loadCatalog();
    const application = createMcpApplication(
      manager,
      () => "actor",
      10_000,
      createModelSurface(registry, 10_000),
    );
    const client = new Client({ name: "bayma-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        application.server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await client.callTool({
        name: "session.acquire_controller",
        arguments: { session_id: sessionId },
      });
      const exec = () =>
        client.callTool({
          name: "exec",
          arguments: { session_id: sessionId, code: "1" },
        });

      const notice = describeExecNotice({ returnedFrom: "process_snapshot" });
      const told = await exec();
      expect(told.isError).toBeFalsy();
      expect(told.content).toEqual([{ type: "text", text: notice }]);
      expect(told.structuredContent).toMatchObject({ status: "ok", notice });

      const untold = await exec();
      expect(untold.content).toEqual([{ type: "text", text: "" }]);
      expect(untold.structuredContent).not.toHaveProperty("notice");
    } finally {
      await client.close();
      await application.server.close();
    }
  });
});
