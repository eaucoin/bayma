import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  launchMcpHttpServer,
  type McpHttpClient,
} from "../../support/mcp-http-client.ts";

const TEST_TIMEOUT_MS = 30_000;
// How long bayma keeps a client live after its last connection ends.
const RECONNECT_GRACE_MS = 10_000;
const SHORT_IDLE_TIMEOUT_MS = 2_000;
const LONG_IDLE_TIMEOUT_MS = 60_000;
const ABANDONED_CLIENT = resolve(
  import.meta.dir,
  "../../support/mcp-http-abandoned-client.ts",
);

/** Run a client process that creates a session, then kill it. */
async function abandonSession(
  url: string,
): Promise<{ sessionId: string; mcpSessionId: string }> {
  const child = Bun.spawn([process.execPath, ABANDONED_CLIENT, url], {
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes("\n")) {
      const { done, value } = await reader.read();
      if (done) throw new Error("client exited before creating a session");
      output += decoder.decode(value, { stream: true });
    }
    return JSON.parse(output.slice(0, output.indexOf("\n")));
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}

async function acquireController(
  client: McpHttpClient,
  sessionId: string,
): Promise<void> {
  await client.callTool("session.acquire_controller", {
    session_id: sessionId,
  });
}

async function expectExec(
  client: McpHttpClient,
  sessionId: string,
): Promise<void> {
  const executed = await client.callTool<{
    done: boolean;
    result_text: string;
  }>("exec", { session_id: sessionId, code: "40 + 2" });
  expect(executed.done).toBe(true);
  expect(executed.result_text).toBe("42");
}

/** Ping the server in an MCP session, and return the response's status. */
async function ping(url: string, mcpSessionId: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": mcpSessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
  });
  await response.body?.cancel();
  return response.status;
}

test(
  "a killed client's session can be taken over once its reconnect grace passes",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: LONG_IDLE_TIMEOUT_MS,
    });
    try {
      const { sessionId, mcpSessionId } = await abandonSession(server.url);
      const killedAtMs = Date.now();
      const successor = await server.spawnClient();
      try {
        await expect(acquireController(successor, sessionId)).rejects.toThrow(
          "controller lease already held",
        );

        const deadline = killedAtMs + RECONNECT_GRACE_MS * 2;
        while (true) {
          try {
            await acquireController(successor, sessionId);
            break;
          } catch (error) {
            if (Date.now() > deadline) throw error;
            await sleep(250);
          }
        }
        await expectExec(successor, sessionId);
        // The killed client's MCP session is still open: the takeover did
        // not wait for the idle timeout to close it.
        expect(await ping(server.url, mcpSessionId)).toBe(200);

        await successor.callTool("session.close", { session_id: sessionId });
      } finally {
        await successor.close();
      }
    } finally {
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "a connected client keeps its controller lease however long it idles",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: SHORT_IDLE_TIMEOUT_MS,
    });
    const controller = await server.spawnClient();
    const other = await server.spawnClient();
    try {
      const created = await controller.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "bun",
        title: "idle-controller",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;

      await sleep(RECONNECT_GRACE_MS + SHORT_IDLE_TIMEOUT_MS);

      await expect(acquireController(other, sessionId)).rejects.toThrow(
        "controller lease already held",
      );
      await expectExec(controller, sessionId);

      await controller.callTool("session.close", { session_id: sessionId });
    } finally {
      await other.close();
      await controller.close();
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "a killed client's MCP session is closed at the idle timeout, releasing its leases",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: SHORT_IDLE_TIMEOUT_MS,
    });
    try {
      const { sessionId, mcpSessionId } = await abandonSession(server.url);
      await sleep(SHORT_IDLE_TIMEOUT_MS * 2);

      expect(await ping(server.url, mcpSessionId)).toBe(404);
      // Still within the reconnect grace, so only the closing released it.
      const successor = await server.spawnClient();
      try {
        await acquireController(successor, sessionId);
        await expectExec(successor, sessionId);
        await successor.callTool("session.close", { session_id: sessionId });
      } finally {
        await successor.close();
      }
    } finally {
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);
