import { expect, test } from "bun:test";
import { sessionExecMessagesUri, sessionExecUri } from "@bayma/core";
import { withMcpStdio } from "../../support/mcp-stdio-client.ts";
import { expectExactMcpSurface } from "../../support/mcp-surface.ts";

const TEST_TIMEOUT_MS = 10_000;

test(
  "mcp-stdio exposes the exact tool and resource surface and their lifecycle",
  async () => {
    await withMcpStdio(async (client) => {
      expectExactMcpSurface({
        tools: await client.listTools(),
        resourceTemplates: await client.listResourceTemplates(),
        resources: await client.listResources(),
      });

      const created = await client.callTool<{
        session: { session_id: string; runtime: string };
      }>("session.create", {
        runtime: "bun",
        title: "mcp-demo",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      expect(created.session.runtime).toBe("bun");

      const rawSnapshot = await client.callToolResult("exec", {
        session_id: sessionId,
        code: `console.log("before")\nawait new Promise((resolve) => setTimeout(resolve, 200))\n1 + 1`,
        yield_time_ms: 100,
      });
      expect(rawSnapshot.isError).toBe(false);

      const snapshot = rawSnapshot.structuredContent as {
        session_id: string;
        exec_id: string;
        status: string;
        done: boolean;
        next_seq: number;
        changed: boolean;
        truncated: boolean;
        stdout_text: string;
        result_text: string;
      };
      const execUri = sessionExecUri(sessionId, snapshot.exec_id);
      const messagesUri = sessionExecMessagesUri(sessionId, snapshot.exec_id);
      await client.subscribeResource(execUri);
      await client.subscribeResource(messagesUri);

      expect(snapshot.session_id).toBe(sessionId);
      expect(snapshot.done).toBe(false);
      expect(
        snapshot.status === "queued" || snapshot.status === "running",
      ).toBe(true);
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.next_seq).toBeGreaterThanOrEqual(1);
      expect(snapshot.result_text).toBe("");
      const inlineText = rawSnapshot.content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");

      if (snapshot.changed) {
        expect(snapshot.next_seq).toBeGreaterThan(1);
        expect(snapshot.stdout_text).toContain("before");
        expect(inlineText).toContain("before");
      } else {
        expect(snapshot.next_seq).toBe(1);
        expect(snapshot.stdout_text).toBe("");
        expect(inlineText.trim()).toBe("");
      }

      const waited = await client.callTool<{
        done: boolean;
        status: string;
        changed: boolean;
        result_text: string;
        stdout_text: string;
      }>("wait", {
        session_id: sessionId,
        exec_id: snapshot.exec_id,
        from_seq: snapshot.next_seq,
        yield_time_ms: 1_000,
      });
      expect(waited.done).toBe(true);
      expect(waited.status).toBe("ok");
      expect(waited.changed).toBe(true);
      expect(waited.result_text).toBe("2");
      expect(`${snapshot.stdout_text}${waited.stdout_text}`).toContain(
        "before",
      );

      await client.waitForResourceUpdate(
        (uri) => uri === execUri || uri === messagesUri,
      );

      const exec = await client.waitForJsonResource<{
        exec: { execId: string; status: string };
      }>(
        execUri,
        (value) =>
          value.exec.execId === snapshot.exec_id && value.exec.status === "ok",
      );
      expect(exec.exec.status).toBe("ok");

      const messages = await client.waitForJsonResource<{
        messages: Array<{ kind: string; text: string }>;
      }>(messagesUri, (value) =>
        value.messages.some(
          (message) => message.kind === "result" && message.text.includes("2"),
        ),
      );
      expect(
        messages.messages.some(
          (message) =>
            message.kind === "stdout" && message.text.includes("before"),
        ),
      ).toBe(true);
      expect(
        messages.messages.some(
          (message) => message.kind === "result" && message.text.includes("2"),
        ),
      ).toBe(true);

      await client.callTool("session.close", { session_id: sessionId });
    });
  },
  TEST_TIMEOUT_MS,
);
