import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  abandonSession,
  launchMcpHttpServer,
  type McpHttpServer,
} from "../../support/mcp-http-client.ts";
import { withTempDir } from "../../support/temp.ts";

// A restored server runs on before its pages are all in, and stops running
// mid-turn of its event loop while it waits for one, however long the store
// takes. The clock runs on meanwhile, and once the server runs again Node
// runs the timers that came due before it reads what came: here, a server
// that SIGUSR2 tells to run no more, for as long, in a turn of its loop.

const TEST_TIMEOUT_MS = 60_000;
// Longer than Node keeps a connection alive for a next request, five
// seconds and its one second to spare.
const STALL_MS = 7_500;
const SHORT_IDLE_TIMEOUT_MS = 2_000;

/** Runs `fn` with a server that stalls for `STALL_MS` at each SIGUSR2. */
async function withStallingServer<T>(
  options: { clientIdleTimeoutMs?: number },
  fn: (server: McpHttpServer, stall: () => void) => Promise<T>,
): Promise<T> {
  return await withTempDir(async (dir) => {
    const preload = join(dir, "stall.mjs");
    writeFileSync(
      preload,
      `process.on("SIGUSR2", () =>
        setImmediate(() =>
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${STALL_MS}),
        ),
      );\n`,
    );
    const server = await launchMcpHttpServer({
      ...options,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`,
      },
    });
    try {
      return await fn(server, () => {
        process.kill(server.child.pid as number, "SIGUSR2");
      });
    } finally {
      await server.close();
    }
  });
}

/** A connection to `url`'s server, with what it has been answered. */
async function connect(url: string) {
  const { hostname, port } = new URL(url);
  const socket = net.connect(Number(port), hostname);
  let answers = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => (answers += chunk));
  socket.on("error", () => undefined);
  await new Promise((resolve) => socket.once("connect", resolve));
  return {
    socket,
    /** Waits for an answer's status line past the first `count`. */
    answered: async (count: number): Promise<string[]> => {
      const deadline = Date.now() + STALL_MS * 2;
      const statuses = () => answers.match(/HTTP\/1\.1 \d+/g) ?? [];
      while (statuses().length <= count) {
        if (socket.closed || Date.now() > deadline) break;
        await sleep(20);
      }
      return statuses();
    },
  };
}

test(
  "the server answers a next request on a connection it keeps alive that came while it did not run, however long past its keep-alive timeout that was",
  async () => {
    await withStallingServer({}, async (server, stall) => {
      const { host } = new URL(server.url);
      const request = `GET /status HTTP/1.1\r\nHost: ${host}\r\n\r\n`;
      const connection = await connect(server.url);
      try {
        connection.socket.write(request);
        expect(await connection.answered(0)).toEqual(["HTTP/1.1 200"]);
        stall();
        await sleep(300);
        connection.socket.write(request);
        expect(await connection.answered(1)).toEqual([
          "HTTP/1.1 200",
          "HTTP/1.1 200",
        ]);
      } finally {
        connection.socket.destroy();
      }
    });
  },
  { timeout: TEST_TIMEOUT_MS },
);

test(
  "a client's request that came while the server did not run keeps its MCP session open, however long past its idle timeout that was",
  async () => {
    await withStallingServer(
      { clientIdleTimeoutMs: SHORT_IDLE_TIMEOUT_MS },
      async (server, stall) => {
        const { host } = new URL(server.url);
        const { mcpSessionId } = await abandonSession(server.url);
        const connection = await connect(server.url);
        try {
          // The abandoned client's connections are closed, and its idle
          // timeout armed, before the server stops running.
          await sleep(300);
          stall();
          await sleep(300);
          const body = JSON.stringify({
            jsonrpc: "2.0",
            method: "ping",
            id: 1,
          });
          connection.socket.write(
            `POST /mcp HTTP/1.1\r\nHost: ${host}\r\n` +
              "Accept: application/json, text/event-stream\r\n" +
              "Content-Type: application/json\r\n" +
              `Mcp-Session-Id: ${mcpSessionId}\r\n` +
              `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          );
          expect(await connection.answered(0)).toEqual(["HTTP/1.1 200"]);
        } finally {
          connection.socket.destroy();
        }
      },
    );
  },
  { timeout: TEST_TIMEOUT_MS },
);
