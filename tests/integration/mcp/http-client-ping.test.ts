import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  launchMcpHttpServer,
  type McpHttpClient,
} from "../../support/mcp-http-client.ts";
import { runSandboxHookCommand } from "../../support/runtimes.ts";

const TEST_TIMEOUT_MS = 30_000;
// How long bayma keeps a client live after its last connection ends.
const RECONNECT_GRACE_MS = 10_000;
const PING_MS = 1_000;
// Longer, for a ping's answer, waited for again as the server runs on, to be
// due well after a resume's hook has ended.
const SAVED_PING_MS = 2_000;
// Longer than any test here runs, so that only a ping unanswered closes a
// client's MCP session.
const LONG_IDLE_TIMEOUT_MS = 60_000;

async function createSession(client: McpHttpClient): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime: "bun", title: "pinged", cwd: process.cwd() },
  );
  return created.session.session_id;
}

/** The status the server answers a ping in the MCP session `mcpSessionId` with. */
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

const MCP_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

/** A JSON-RPC message posted in `mcpSessionId`, its answer's JSON-RPC result, where it has one. */
async function post(
  url: string,
  mcpSessionId: string | undefined,
  message: object,
): Promise<{ status: number; mcpSessionId: string | null; result?: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...MCP_HEADERS,
      ...(mcpSessionId === undefined ? {} : { "mcp-session-id": mcpSessionId }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...message }),
  });
  const text = await response.text();
  const data =
    text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) =>
          JSON.parse(line.slice("data: ".length)) as { result?: unknown },
      )
      .at(-1) ??
    (text.startsWith("{") ? (JSON.parse(text) as { result?: unknown }) : {});
  return {
    status: response.status,
    mcpSessionId: response.headers.get("mcp-session-id"),
    result: data.result,
  };
}

/**
 * The server's stream of messages to the MCP session `mcpSessionId`, opened
 * as a client opens it, asked for again while the server still holds the
 * session's last one open, as a client asks again for one it lost, with each
 * ping it is sent, as it comes, and a way to drop it, as a connection is
 * dropped.
 */
async function openStream(
  url: string,
  mcpSessionId: string,
): Promise<{ pings: AsyncGenerator<string | number>; drop: () => void }> {
  for (let attempt = 0; ; attempt += 1) {
    const dropped = new AbortController();
    const response = await fetch(url, {
      headers: { accept: "text/event-stream", "mcp-session-id": mcpSessionId },
      signal: dropped.signal,
    });
    // One stream at a time: the last, dropped, may not yet be seen to end.
    if (response.status === 409 && attempt < 100) {
      await response.body?.cancel();
      await sleep(50);
      continue;
    }
    expect(response.status).toBe(200);
    return { pings: pings(response), drop: () => dropped.abort() };
  }
}

/** Each ping the stream `response` brings, as it comes, until it ends. */
async function* pings(response: Response): AsyncGenerator<string | number> {
  const body = response.body!.pipeThrough(new TextDecoderStream());
  let buffered = "";
  try {
    for await (const chunk of body) {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf("\n\n")) !== -1) {
        const event = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const message = JSON.parse(line.slice("data: ".length)) as {
            method?: string;
            id?: string | number;
          };
          if (message.method === "ping" && message.id !== undefined)
            yield message.id;
        }
      }
    }
  } catch {
    // Dropped.
  }
}

test(
  "a client that holds its stream open but answers no ping on it has its MCP session closed within two ping intervals, and its controller leases taken over",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: LONG_IDLE_TIMEOUT_MS,
      clientPingMs: PING_MS,
    });
    const gone = await server.spawnClient();
    const successor = await server.spawnClient();
    try {
      const sessionId = await createSession(gone);
      const mcpSessionId = gone.mcpSessionId!;
      // Its stream open, as a client's process may hold one that it no
      // longer reads, or a proxy past the client's end: it answers nothing.
      gone.client.setRequestHandler("ping", () => new Promise(() => {}));
      const stoppedAtMs = Date.now();

      while ((await ping(server.url, mcpSessionId)) === 200) {
        expect(Date.now() - stoppedAtMs).toBeLessThan(3 * PING_MS + 1_000);
        await sleep(100);
      }
      expect(await ping(server.url, mcpSessionId)).toBe(404);
      // Well within the reconnect grace: the session's closing released it.
      await successor.callTool("session.acquire_controller", {
        session_id: sessionId,
      });
      expect(Date.now() - stoppedAtMs).toBeLessThan(RECONNECT_GRACE_MS);
      await successor.callTool("session.close", { session_id: sessionId });
    } finally {
      await successor.close();
      await gone.close().catch(() => undefined);
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "a ping unanswered while the server is saved is not held against its client: it is waited for until the server runs on",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: LONG_IDLE_TIMEOUT_MS,
      clientPingMs: SAVED_PING_MS,
    });
    const quiet = await server.spawnClient();
    try {
      await createSession(quiet);
      const mcpSessionId = quiet.mcpSessionId!;
      quiet.client.setRequestHandler("ping", () => new Promise(() => {}));
      // Saved with a ping sent, its answer not yet due.
      await sleep(SAVED_PING_MS + SAVED_PING_MS / 4);
      expect(await runSandboxHookCommand(server.stateDir, "save")).toEqual({
        status: 0,
        stderr: "",
      });
      await sleep(4 * SAVED_PING_MS);
      expect(await runSandboxHookCommand(server.stateDir, "resume")).toEqual({
        status: 0,
        stderr: "",
      });
      // Saved, no ping's answer was waited for: its session is still open,
      // until one sent since goes unanswered.
      expect(await ping(server.url, mcpSessionId)).toBe(200);
      const resumedAtMs = Date.now();
      while ((await ping(server.url, mcpSessionId)) === 200) {
        expect(Date.now() - resumedAtMs).toBeLessThan(
          3 * SAVED_PING_MS + 1_000,
        );
        await sleep(100);
      }
    } finally {
      await quiet.close().catch(() => undefined);
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "a ping whose stream drops before its answer counts for nothing: the client, its stream reopened and its pings answered on it, keeps its MCP session and its lease",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: LONG_IDLE_TIMEOUT_MS,
      clientPingMs: PING_MS,
    });
    const other = await server.spawnClient();
    try {
      const initialized = await post(server.url, undefined, {
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "bayma-ping-test-client", version: "1.0.0" },
        },
      });
      const mcpSessionId = initialized.mcpSessionId!;
      await post(server.url, mcpSessionId, {
        method: "notifications/initialized",
      });
      const created = (await post(server.url, mcpSessionId, {
        id: 2,
        method: "tools/call",
        params: {
          name: "session.create",
          arguments: { runtime: "bun", title: "redialled", cwd: process.cwd() },
        },
      })) as {
        result?: { structuredContent?: { session?: { session_id?: string } } };
      };
      const sessionId = created.result!.structuredContent!.session!.session_id!;

      // A ping comes on the first stream, which drops before it is answered.
      const first = await openStream(server.url, mcpSessionId);
      await first.pings.next();
      first.drop();
      // The client opens its stream again, and answers each ping on it.
      const second = await openStream(server.url, mcpSessionId);
      const answering = (async () => {
        for await (const id of second.pings)
          await post(server.url, mcpSessionId, { id, result: {} });
      })();
      try {
        await sleep(4 * PING_MS);
        expect(await ping(server.url, mcpSessionId)).toBe(200);
        await expect(
          other.callTool("session.acquire_controller", {
            session_id: sessionId,
          }),
        ).rejects.toThrow("controller lease already held");
      } finally {
        second.drop();
        await answering;
      }
    } finally {
      await other.close();
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "a client that answers its pings with an error has answered: it keeps its MCP session and its lease",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: LONG_IDLE_TIMEOUT_MS,
      clientPingMs: PING_MS,
    });
    const refusing = await server.spawnClient();
    const other = await server.spawnClient();
    try {
      const sessionId = await createSession(refusing);
      refusing.client.setRequestHandler("ping", () => {
        throw new Error("no pings here");
      });
      await sleep(4 * PING_MS);

      expect(await ping(server.url, refusing.mcpSessionId!)).toBe(200);
      await expect(
        other.callTool("session.acquire_controller", { session_id: sessionId }),
      ).rejects.toThrow("controller lease already held");
      await refusing.callTool("session.close", { session_id: sessionId });
    } finally {
      await other.close();
      await refusing.close();
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "a client that answers its pings keeps its MCP session and its controller lease, however many it is sent",
  async () => {
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: LONG_IDLE_TIMEOUT_MS,
      clientPingMs: PING_MS,
    });
    const controller = await server.spawnClient();
    const other = await server.spawnClient();
    try {
      const sessionId = await createSession(controller);
      await sleep(5 * PING_MS);

      expect(await ping(server.url, controller.mcpSessionId!)).toBe(200);
      await expect(
        other.callTool("session.acquire_controller", { session_id: sessionId }),
      ).rejects.toThrow("controller lease already held");
      await controller.callTool("session.close", { session_id: sessionId });
    } finally {
      await other.close();
      await controller.close();
      await server.close();
    }
  },
  { timeout: TEST_TIMEOUT_MS },
);
