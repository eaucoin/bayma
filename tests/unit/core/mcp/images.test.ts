import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  CheckpointStore,
  createMcpApplication,
  createModelSurface,
  ExecHistoryStore,
  RuntimeRegistry,
  SessionCatalogStore,
  sessionExecImageUri,
  SessionManager,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../support/fake-transport.ts";
import { withTempDir } from "../../../support/temp.ts";

// A one-pixel PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("snapshots carry the images an exec showed as image content, and each image is a blob resource", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const registry = new RuntimeRegistry([{ adapter: bunAdapter, transport }]);
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
    const { sessionId } = await manager.createWithPolicy(
      "actor",
      "images",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    const { execId } = await manager.submitExec(sessionId, "actor", "show()");
    const marker = transport.pendingEventPrefix(sessionId);
    const payloadPath = join(dir, "plot.png");
    writeFileSync(payloadPath, PNG);
    for (const envelope of [
      { kind: "stdout", text: "plotted\n" },
      { kind: "image", payloadPath },
      { kind: "result", text: "42" },
    ]) {
      transport.emit(sessionId, `${marker}${JSON.stringify(envelope)}\n`);
    }
    transport.completeNext(sessionId);
    await Bun.sleep(0);

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
      const uri = sessionExecImageUri(sessionId, execId, 2);

      const waited = await client.callTool({
        name: "wait",
        arguments: { session_id: sessionId, exec_id: execId },
      });
      expect(waited.isError).toBeFalsy();
      expect(waited.content).toEqual([
        { type: "text", text: "plotted\n42" },
        { type: "image", data: PNG.toString("base64"), mimeType: "image/png" },
      ]);
      expect(waited.structuredContent).toMatchObject({
        stdout_text: "plotted\n",
        result_text: "42",
        images: [{ seq: 2, mime_type: "image/png", uri }],
      });

      // A later snapshot holds only what came at or after its from_seq.
      const later = await client.callTool({
        name: "wait",
        arguments: { session_id: sessionId, exec_id: execId, from_seq: 3 },
      });
      expect(later.content).toEqual([{ type: "text", text: "42" }]);
      expect(later.structuredContent).toMatchObject({ images: [] });

      const templates = await client.listResourceTemplates();
      expect(
        templates.resourceTemplates.map((template) => template.uriTemplate),
      ).toContain("bayma:///session/{sessionId}/exec/{execId}/image/{seq}");
      expect((await client.readResource({ uri })).contents).toEqual([
        { uri, mimeType: "image/png", blob: PNG.toString("base64") },
      ]);
      await expect(
        client.readResource({ uri: sessionExecImageUri(sessionId, execId, 1) }),
      ).rejects.toThrow("has no image at seq 1");
    } finally {
      await client.close();
      await application.server.close();
      await manager.shutdown();
    }
  });
});
