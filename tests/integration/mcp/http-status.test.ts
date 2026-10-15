import { expect, test } from "bun:test";
import type { ExecActivity } from "@bayma/core";
import { launchMcpHttpServer } from "../../support/mcp-http-client.ts";

const TEST_TIMEOUT_MS = 30_000;
const TOKEN = "bayma-test-token";

async function status(
  url: string,
  init: RequestInit = { headers: { authorization: `Bearer ${TOKEN}` } },
): Promise<Response> {
  return await fetch(new URL("/status", url), init);
}

async function activity(url: string): Promise<ExecActivity> {
  const response = await status(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  return (await response.json()) as ExecActivity;
}

test(
  "GET /status tells how many execs run and wait, and since when none has",
  async () => {
    const server = await launchMcpHttpServer({ bearerToken: TOKEN });
    const client = await server.spawnClient();
    try {
      expect((await status(server.url, {})).status).toBe(401);
      expect(
        (
          await status(server.url, {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}` },
          })
        ).status,
      ).toBe(405);
      const started = await activity(server.url);
      expect(started).toEqual({
        execsRunning: 0,
        execsQueued: 0,
        running: [],
        idleSinceMs: expect.any(Number),
        generation: expect.any(Number),
      });

      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "bun",
        title: "http-status",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      // Each call returns while its exec still runs, or waits to.
      const execIds: string[] = [];
      for (const code of ["await Bun.sleep(1_000)", "40 + 2"]) {
        const yielded = await client.callTool<{
          done: boolean;
          exec_id: string;
        }>("exec", {
          session_id: sessionId,
          code,
          yield_time_ms: 0,
        });
        expect(yielded.done).toBe(false);
        execIds.push(yielded.exec_id);
      }
      expect(await activity(server.url)).toEqual({
        execsRunning: 1,
        execsQueued: 1,
        running: [{ sessionId, execId: execIds[0]! }],
        idleSinceMs: null,
        generation: expect.any(Number),
      });

      const deadline = Date.now() + 10_000;
      let idle = await activity(server.url);
      while (idle.idleSinceMs === null && Date.now() < deadline) {
        await Bun.sleep(50);
        idle = await activity(server.url);
      }
      expect(idle).toEqual({
        execsRunning: 0,
        execsQueued: 0,
        running: [],
        idleSinceMs: expect.any(Number),
        generation: expect.any(Number),
      });
      expect(idle.idleSinceMs).toBeGreaterThan(started.idleSinceMs!);
    } finally {
      await client.close();
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);
