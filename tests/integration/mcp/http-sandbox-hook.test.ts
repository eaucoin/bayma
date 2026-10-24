import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  abandonSession,
  launchMcpHttpServer,
} from "../../support/mcp-http-client.ts";
import { runSandboxHookCommand } from "../../support/runtimes.ts";

// What a host that saves and restores the sandbox mcp-http runs in sees of
// the hook it runs in the sandbox around the save. The clocks do not jump
// here, as a restore's do: what the hook holds and starts again is what
// would fire as they jump.

const TEST_TIMEOUT_MS = 60_000;
// How long bayma keeps a client live after its last connection ends.
const RECONNECT_GRACE_MS = 10_000;
const TOKEN = "first-token";

/** Whether `response` settles within `ms`. */
async function answeredWithin(
  response: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return Promise.race([response.then(() => true), sleep(ms).then(() => false)]);
}

async function hook(
  stateDir: string,
  mode: string,
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  expect(
    await runSandboxHookCommand(stateDir, mode, "environment", env),
  ).toEqual({
    status: 0,
    stderr: "",
  });
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
  "a restore reads the token file again: the old token is refused, the new one served",
  async () => {
    const server = await launchMcpHttpServer({ bearerToken: TOKEN });
    const status = async (token: string) =>
      (
        await fetch(new URL("/status", server.url), {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status;
    try {
      expect(await status(TOKEN)).toBe(200);
      await hook(server.stateDir, "save");
      writeFileSync(server.tokenFile, "second-token\n");
      // Saved, the server holds a request until it knows whose token it
      // answers.
      const held = status(TOKEN);
      expect(await answeredWithin(held, 1_000)).toBe(false);

      await hook(server.stateDir, "restore");
      expect(await held).toBe(401);
      expect(await status("second-token")).toBe(200);
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a resume after a save lets the requests it held in, under the token it read",
  async () => {
    const server = await launchMcpHttpServer({ bearerToken: TOKEN });
    try {
      await hook(server.stateDir, "save");
      writeFileSync(server.tokenFile, "second-token\n");
      const held = fetch(new URL("/status", server.url), {
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      await hook(server.stateDir, "resume");
      expect((await held).status).toBe(200);
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a request a saved server holds longer than a restore's hook takes is to be sent again",
  async () => {
    const server = await launchMcpHttpServer({ bearerToken: TOKEN });
    try {
      await hook(server.stateDir, "save");
      const heldAtMs = Date.now();
      const response = await fetch(new URL("/status", server.url), {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(Date.now() - heldAtMs).toBeGreaterThanOrEqual(9_000);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      await hook(server.stateDir, "resume");
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a restore with no token file to read fails, and lets no request in",
  async () => {
    const server = await launchMcpHttpServer({ bearerToken: TOKEN });
    try {
      await hook(server.stateDir, "save");
      rmSync(server.tokenFile);

      const restored = await runSandboxHookCommand(server.stateDir, "restore");
      expect(restored.status).not.toBe(0);
      expect(restored.stderr).toContain("could not restore: ENOENT");
      const response = await fetch(new URL("/status", server.url), {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a client's idle timeout waits out a save, and starts again at the restore",
  async () => {
    const idleTimeoutMs = 3_000;
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: idleTimeoutMs,
    });
    try {
      const { mcpSessionId } = await abandonSession(server.url);
      await hook(server.stateDir, "save");
      await sleep(idleTimeoutMs * 3);
      await hook(server.stateDir, "restore");
      expect(await ping(server.url, mcpSessionId)).toBe(200);

      await sleep(idleTimeoutMs * 3);
      expect(await ping(server.url, mcpSessionId)).toBe(404);
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a resume leaves a client's idle timeout running as it was",
  async () => {
    const idleTimeoutMs = 6_000;
    const server = await launchMcpHttpServer({
      clientIdleTimeoutMs: idleTimeoutMs,
    });
    try {
      const { mcpSessionId } = await abandonSession(server.url);
      const abandonedAtMs = Date.now();
      await sleep(1_000);
      // Each hook is a process of its own, which takes a second or so to
      // start on a busy machine: the timeout leaves them room to resume the
      // server before the timeout armed before the save would end.
      await hook(server.stateDir, "save");
      await hook(server.stateDir, "resume");
      expect(Date.now() - abandonedAtMs).toBeLessThan(idleTimeoutMs);
      // Past the timeout armed before the save, short of one started again
      // at the resume, a second or more after it.
      await sleep(abandonedAtMs + idleTimeoutMs + 500 - Date.now());
      expect(await ping(server.url, mcpSessionId)).toBe(404);
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a client's reconnect grace starts again at the restore",
  async () => {
    const server = await launchMcpHttpServer({ clientIdleTimeoutMs: 60_000 });
    try {
      const { sessionId } = await abandonSession(server.url);
      await hook(server.stateDir, "save");
      // Longer than the grace the killed client had when it went.
      await sleep(RECONNECT_GRACE_MS + 1_000);

      await hook(server.stateDir, "restore");
      const restoredAtMs = Date.now();
      const successor = await server.spawnClient();
      try {
        await successor.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        expect(Date.now() - restoredAtMs).toBeGreaterThanOrEqual(
          RECONNECT_GRACE_MS - 1_000,
        );
        await successor.callTool("session.close", { session_id: sessionId });
      } finally {
        await successor.close();
      }
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a session's exec running at the save, and the next exec of one idle, are told of the restore, and of why its host stopped the sandbox",
  async () => {
    const server = await launchMcpHttpServer();
    const client = await server.spawnClient();
    try {
      const sessionIds: string[] = [];
      for (const title of ["busy", "idle"]) {
        const created = await client.callTool<{
          session: { session_id: string };
        }>("session.create", { runtime: "bun", title, cwd: process.cwd() });
        sessionIds.push(created.session.session_id);
      }
      const [busy, idle] = sessionIds as [string, string];
      // Running until the test lets it end, after the restore.
      const flag = join(server.stateDir, "..", "restored");
      const running = await client.callTool<{ exec_id: string; done: boolean }>(
        "exec",
        {
          session_id: busy,
          code: `while (!require("node:fs").existsSync(${JSON.stringify(flag)})) await Bun.sleep(50); 42`,
          yield_time_ms: 0,
        },
      );
      expect(running.done).toBe(false);

      const savedAtMs = Date.now();
      await hook(server.stateDir, "save");
      await hook(server.stateDir, "restore", {
        BAYMA_SANDBOX_STOP_REASON: "it ran out of its memory (4Gi)",
      });
      writeFileSync(flag, "");

      const told = (snapshot: { notice?: string }) =>
        snapshot.notice?.match(
          /^bayma: this session came back whole with bayma's sandbox, restored from a snapshot taken at (\S+), after the sandbox was stopped as it ran out of its memory \(4Gi\); its live state is as it was then, so what ran in it since is gone, but its network connections were closed\.$/,
        )?.[1];
      const finished = await client.callTool<{
        done: boolean;
        result_text: string;
        notice?: string;
      }>("wait", {
        session_id: busy,
        exec_id: running.exec_id,
        yield_time_ms: 10_000,
      });
      expect(finished.result_text).toBe("42");
      const next = await client.callTool<{ notice?: string }>("exec", {
        session_id: idle,
        code: "1",
      });
      for (const snapshot of [finished, next]) {
        const takenAt = told(snapshot);
        expect(takenAt).toBeDefined();
        expect(Date.parse(takenAt!)).toBeGreaterThanOrEqual(savedAtMs);
      }
      const later = await client.callTool<{ notice?: string }>("exec", {
        session_id: idle,
        code: "2",
      });
      expect(later.notice).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "the hook fails, and says why, with no server to answer it",
  async () => {
    const server = await launchMcpHttpServer();
    try {
      await server.stop();
      const { status, stderr } = await runSandboxHookCommand(
        server.stateDir,
        "save",
      );
      expect(status).not.toBe(0);
      expect(stderr).toContain("no bayma server answers on");
      // Run from the sandbox's root, the hook is told the server's.
      const unnamed = await runSandboxHookCommand(undefined, "save");
      expect(unnamed.status).not.toBe(0);
      expect(unnamed.stderr).toContain("sandbox-hook needs --state-dir");
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

/** Whether the server's process exits within `ms`. */
async function exitsWithin(
  server: { child: import("node:child_process").ChildProcess },
  ms: number,
): Promise<boolean> {
  if (server.child.exitCode !== null || server.child.signalCode !== null)
    return true;
  server.child.ref();
  try {
    return await answeredWithin(
      new Promise((resolve) => server.child.once("exit", resolve)),
      ms,
    );
  } finally {
    server.child.unref();
  }
}

/** A session of the server's, the client's to exec in. */
async function sessionOf(client: {
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
}): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime: "bun", title: "held", cwd: process.cwd() },
  );
  return created.session.session_id;
}

test(
  "SIGTERM's stop, held for a save, takes no new session or exec, lets what runs carry on, and goes on at sandbox-hook stop",
  async () => {
    const server = await launchMcpHttpServer({ stopWaitMs: 60_000 });
    const client = await server.spawnClient();
    try {
      const sessionId = await sessionOf(client);
      const flag = join(server.stateDir, "..", "carried-on");
      const running = await client.callTool<{ exec_id: string }>("exec", {
        session_id: sessionId,
        code: `while (!require("node:fs").existsSync(${JSON.stringify(flag)})) await Bun.sleep(50); 42`,
        yield_time_ms: 0,
      });
      process.kill(server.child.pid!, "SIGTERM");
      await sleep(200);
      expect(await exitsWithin(server, 0)).toBe(false);
      await expect(
        client.callTool("exec", { session_id: sessionId, code: "1" }),
      ).rejects.toThrow("the server is stopping");
      // What ran as the stop was held carries on, to its end.
      writeFileSync(flag, "");
      const finished = await client.callTool<{ result_text: string }>("wait", {
        session_id: sessionId,
        exec_id: running.exec_id,
        yield_time_ms: 10_000,
      });
      expect(finished.result_text).toBe("42");
      await expect(sessionOf(client)).rejects.toThrow("the server is stopping");
      // Its sessions are served still, for whoever reads them.
      expect((await fetch(new URL("/status", server.url))).status).not.toBe(
        503,
      );
      await hook(server.stateDir, "stop");
      expect(await exitsWithin(server, 10_000)).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a restore from a save that caught the held stop lets it go, as its old pod's, and the server runs on",
  async () => {
    const server = await launchMcpHttpServer({ stopWaitMs: 2_000 });
    const client = await server.spawnClient();
    try {
      const sessionId = await sessionOf(client);
      process.kill(server.child.pid!, "SIGTERM");
      await sleep(200);
      await hook(server.stateDir, "save");
      await hook(server.stateDir, "restore");
      // Past the wait, it runs on, and starts what it is asked to.
      await sleep(3_000);
      expect(await exitsWithin(server, 0)).toBe(false);
      const ran = await client.callTool<{ result_text: string }>("exec", {
        session_id: sessionId,
        code: "40 + 2",
      });
      expect(ran.result_text).toBe("42");
    } finally {
      await client.close();
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "the held stop goes on once its wait ends with no save, and at once after a save that failed or left the sandbox running",
  async () => {
    const waited = await launchMcpHttpServer({ stopWaitMs: 1_000 });
    try {
      process.kill(waited.child.pid!, "SIGTERM");
      expect(await exitsWithin(waited, 200)).toBe(false);
      expect(await exitsWithin(waited, 10_000)).toBe(true);
    } finally {
      await waited.close();
    }
    const resumed = await launchMcpHttpServer({ stopWaitMs: 60_000 });
    try {
      process.kill(resumed.child.pid!, "SIGTERM");
      await sleep(200);
      await hook(resumed.stateDir, "save");
      await hook(resumed.stateDir, "resume");
      expect(await exitsWithin(resumed, 10_000)).toBe(true);
    } finally {
      await resumed.close();
    }
  },
  TEST_TIMEOUT_MS,
);
