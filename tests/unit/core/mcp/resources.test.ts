import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  createMcpApplication,
  SERVER_EVENTS_URI,
  SESSIONS_URI,
  SubscribedResourceUpdatePublisher,
  sessionExecUri,
  sessionUri,
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  SessionManager,
  RuntimeRegistry,
  createModelSurface,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../support/fake-transport.ts";
import { withTempDir } from "../../../support/temp.ts";

// As many sessions as the store whose listing came to 16.9 MB, past the 16 MB Claude Code
// takes in one message, and more execs.
const SESSIONS = 200;
const EXECS_PER_SESSION = 300;

test("MCP resource listing lists sessions alone, small however many execs they ran, and keeps the execs' templates", async () => {
  await withTempDir(async (dir) => {
    const catalogStore = new SessionCatalogStore(dir);
    const historyStore = new ExecHistoryStore(dir);
    const sessionIds = Array.from(
      { length: SESSIONS },
      (_, index) => `sess_${String(index).padStart(4, "0")}`,
    );
    for (const sessionId of sessionIds) {
      catalogStore.write({
        sessionId,
        runtimeId: "bun",
        title: `workbench ${sessionId}`,
        cwd: dir,
        status: "live_idle",
        durabilityMode: "checkpointed",
        runtimeGeneration: 1,
        createdAtMs: 1,
        updatedAtMs: 2,
        closed: false,
        cols: 80,
        rows: 24,
      });
      historyStore.write(
        sessionId,
        Array.from({ length: EXECS_PER_SESSION }, (_, index) => ({
          execId: `exec_${String(index).padStart(4, "0")}`,
          code: "1 + 1",
          status: "ok" as const,
          submittedAtMs: 1,
          startedAtMs: 1,
          finishedAtMs: 2,
          durationMs: 1,
          messages: [],
        })),
      );
    }
    const registry = new RuntimeRegistry([
      { adapter: bunAdapter, transport: new FakeTransport() },
    ]);
    const manager = new SessionManager(
      registry,
      catalogStore,
      historyStore,
      new CheckpointStore(dir),
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );
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
      const listed = await client.listResources();
      expect(listed.resources.map((resource) => resource.uri).sort()).toEqual(
        [
          SESSIONS_URI,
          SERVER_EVENTS_URI,
          ...sessionIds.map((sessionId) => sessionUri(sessionId)),
        ].sort(),
      );
      // 43 KB, where the execs listed too came to 28.8 MB.
      expect(JSON.stringify(listed).length).toBeLessThan(64 * 1024);
      const templates = await client.listResourceTemplates();
      expect(
        templates.resourceTemplates.map((template) => template.uriTemplate),
      ).toEqual(
        expect.arrayContaining([
          "bayma:///session/{sessionId}/exec/{execId}",
          "bayma:///session/{sessionId}/exec/{execId}/messages",
        ]),
      );
      // And an exec's resource is read by its URI, as before.
      const execUri = sessionExecUri(sessionIds[0]!, "exec_0000");
      expect((await client.readResource({ uri: execUri })).contents).toEqual([
        expect.objectContaining({
          uri: execUri,
          text: expect.stringContaining('"execId": "exec_0000"'),
        }),
      ]);
    } finally {
      await client.close();
      await application.server.close();
      await manager.shutdown();
    }
  });
});

test("a session's start and close change the resource list, and an exec's start does not", async () => {
  let listChanges = 0;
  const updatedUris: string[] = [];
  const server = {
    server: {
      async sendResourceListChanged() {
        listChanges += 1;
      },
      async sendResourceUpdated({ uri }: { uri: string }) {
        updatedUris.push(uri);
      },
    },
  } as unknown as McpServer;
  const sessionId = "sess_00000000-0000-4000-8000-000000000000";
  const execId = "exec_00000000-0000-4000-8000-000000000000";
  const subscriptions = new Set([sessionExecUri(sessionId, execId)]);
  const publisher = new SubscribedResourceUpdatePublisher(
    server,
    subscriptions,
  );

  publisher.publish({
    type: "session/started",
    sessionId,
    status: "live_idle",
  });
  await publisher.flush();
  expect(listChanges).toBe(1);

  publisher.publish({
    type: "exec/started",
    sessionId,
    execId,
    startedAtMs: 1,
  });
  await publisher.flush();
  expect(listChanges).toBe(1);
  expect(updatedUris).toEqual([sessionExecUri(sessionId, execId)]);

  publisher.publish({ type: "session/closed", sessionId, reason: "closed" });
  await publisher.flush();
  expect(listChanges).toBe(2);
});
