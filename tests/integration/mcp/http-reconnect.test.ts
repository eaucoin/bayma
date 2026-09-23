import { expect, test } from "bun:test";
import { sessionExecMessagesUri, sessionExecUri } from "@bayma/core";
import { launchMcpHttpServer } from "../../support/mcp-http-client.ts";

const TEST_TIMEOUT_MS = 10_000;

test(
  "mcp-http preserves session state across a reconnect",
  async () => {
    const server = await launchMcpHttpServer();
    const seedClient = await server.spawnClient();

    try {
      const created = await seedClient.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "bun",
        title: "http-reconnect",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      const seed = await seedClient.callTool<{ exec_id: string }>("exec", {
        session_id: sessionId,
        code: "const persisted = 41",
      });
      const seedExecUri = sessionExecUri(sessionId, seed.exec_id);

      await seedClient.waitForJsonResource<{
        exec: { execId: string; status: string };
      }>(
        seedExecUri,
        (value) =>
          value.exec.execId === seed.exec_id && value.exec.status === "ok",
      );

      await seedClient.close();

      const reconnect = await server.spawnClient();
      try {
        await reconnect.callTool("session.acquire_controller", {
          session_id: sessionId,
        });

        const after = await reconnect.callTool<{ exec_id: string }>("exec", {
          session_id: sessionId,
          code: "persisted + 1",
        });
        const afterExecUri = sessionExecUri(sessionId, after.exec_id);
        const afterMessagesUri = sessionExecMessagesUri(
          sessionId,
          after.exec_id,
        );

        const exec = await reconnect.waitForJsonResource<{
          exec: { execId: string; status: string };
        }>(
          afterExecUri,
          (value) =>
            value.exec.execId === after.exec_id && value.exec.status === "ok",
        );
        expect(exec.exec.status).toBe("ok");

        const messages = await reconnect.waitForJsonResource<{
          messages: Array<{ kind: string; text: string }>;
        }>(afterMessagesUri, (value) =>
          value.messages.some(
            (message) =>
              message.kind === "result" && message.text.includes("42"),
          ),
        );
        expect(
          messages.messages.some(
            (message) =>
              message.kind === "result" && message.text.includes("42"),
          ),
        ).toBe(true);

        await reconnect.callTool("session.close", { session_id: sessionId });
      } finally {
        await reconnect.close();
      }
    } finally {
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);
