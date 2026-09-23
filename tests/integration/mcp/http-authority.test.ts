import { expect, test } from "bun:test";
import net from "node:net";
import { sessionExecMessagesUri, sessionExecUri } from "@bayma/core";
import { launchMcpHttpServer } from "../../support/mcp-http-client.ts";

const TEST_TIMEOUT_MS = 10_000;

async function requestWithMalformedHost(url: string): Promise<string> {
  const target = new URL(url);
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(
      Number(target.port),
      target.hostname,
      () => {
        socket.write(
          `GET /not-mcp HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

test(
  "mcp-http separates the controller from read-only clients",
  async () => {
    const server = await launchMcpHttpServer();
    const controller = await server.spawnClient();
    const observer = await server.spawnClient();

    try {
      const created = await controller.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "bun",
        title: "http-authority",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;

      await expect(
        observer.callTool("exec", {
          session_id: sessionId,
          code: "1 + 1",
        }),
      ).rejects.toThrow("write action requires controller lease");
      await expect(
        observer.callTool("session.close", { session_id: sessionId }),
      ).rejects.toThrow("write action requires controller lease");

      const submitted = await controller.callTool<{
        exec_id: string;
        next_seq: number;
        done: boolean;
        status: string;
      }>("exec", {
        session_id: sessionId,
        code: `console.log("controller")\nawait new Promise((resolve) => setTimeout(resolve, 200))\n1 + 1`,
        yield_time_ms: 25,
      });
      const execUri = sessionExecUri(sessionId, submitted.exec_id);
      const messagesUri = sessionExecMessagesUri(sessionId, submitted.exec_id);
      await observer.subscribeResource(execUri);
      await observer.subscribeResource(messagesUri);
      expect(submitted.done).toBe(false);
      expect(
        submitted.status === "queued" || submitted.status === "running",
      ).toBe(true);

      const waited = await observer.callTool<{
        done: boolean;
        status: string;
        changed: boolean;
        result_text: string;
      }>("wait", {
        session_id: sessionId,
        exec_id: submitted.exec_id,
        from_seq: submitted.next_seq,
        yield_time_ms: 1_000,
      });
      expect(waited.done).toBe(true);
      expect(waited.status).toBe("ok");
      expect(waited.changed).toBe(true);
      expect(waited.result_text).toBe("2");

      const exec = await observer.waitForJsonResource<{
        exec: { execId: string; status: string };
      }>(
        execUri,
        (value) =>
          value.exec.execId === submitted.exec_id && value.exec.status === "ok",
      );
      expect(exec.exec.status).toBe("ok");

      const messages = await observer.waitForJsonResource<{
        messages: Array<{ kind: string; text: string }>;
      }>(messagesUri, (value) =>
        value.messages.some(
          (message) =>
            message.kind === "stdout" && message.text.includes("controller"),
        ),
      );
      expect(
        messages.messages.some(
          (message) =>
            message.kind === "stdout" && message.text.includes("controller"),
        ),
      ).toBe(true);

      await controller.callTool("session.close", { session_id: sessionId });
    } finally {
      await observer.close();
      await controller.close();
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "malformed and oversized requests fail without poisoning the server",
  async () => {
    const server = await launchMcpHttpServer();
    try {
      const malformed = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: -32700 }),
        }),
      );

      const oversized = await fetch(server.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }),
      });
      expect(oversized.status).toBe(413);

      expect(await requestWithMalformedHost(server.url)).toStartWith(
        "HTTP/1.1 403",
      );

      const hostileOrigin = await fetch(server.url, {
        headers: { origin: "https://attacker.invalid" },
      });
      expect(hostileOrigin.status).toBe(403);

      const healthyClient = await server.spawnClient();
      await healthyClient.close();
    } finally {
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);
