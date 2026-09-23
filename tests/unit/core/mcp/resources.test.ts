import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  createMcpApplication,
  SubscribedResourceUpdatePublisher,
  sessionExecMessagesUri,
  sessionExecUri,
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

test("MCP resource listing projects exec IDs without cloning payloads", async () => {
  await withTempDir(async (dir) => {
    const registry = new RuntimeRegistry([
      { adapter: bunAdapter, transport: new FakeTransport() },
    ]);
    const manager = new SessionManager(
      registry,
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
    const created = await manager.create("actor", "bounded listing", dir);
    const submitted = await manager.submitExec(
      created.sessionId,
      "actor",
      `"${"payload".repeat(10_000)}"`,
    );

    manager.execs = () => {
      throw new Error("resource listing cloned full execution payloads");
    };

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
      const uris = listed.resources.map((resource) => resource.uri);
      expect(uris).toContain(
        sessionExecUri(created.sessionId, submitted.execId),
      );
      expect(uris).toContain(
        sessionExecMessagesUri(created.sessionId, submitted.execId),
      );
    } finally {
      await client.close();
      await application.server.close();
      await manager.shutdown();
    }
  });
});

test("exec creation notifies clients that the resource list changed", async () => {
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
    type: "exec/started",
    sessionId,
    execId,
    startedAtMs: 1,
  });
  await publisher.flush();

  expect(listChanges).toBe(1);
  expect(updatedUris).toEqual([sessionExecUri(sessionId, execId)]);
});
