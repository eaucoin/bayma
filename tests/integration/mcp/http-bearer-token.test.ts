import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchMcpHttpServer } from "../../support/mcp-http-client.ts";
import { launchSpec } from "../../support/runtimes.ts";

const TEST_TIMEOUT_MS = 10_000;
const TOKEN = "bayma-test-token";

async function ping(url: string, authorization?: string): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
  });
}

test(
  "mcp-http with a token file refuses requests without its bearer token",
  async () => {
    const server = await launchMcpHttpServer({ bearerToken: TOKEN });
    try {
      for (const authorization of [
        undefined,
        "Bearer",
        "Bearer wrong-token",
        `Bearer ${TOKEN}x`,
        `Basic ${TOKEN}`,
        TOKEN,
      ]) {
        const response = await ping(server.url, authorization);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toBe("Bearer");
      }
      // The token is checked before routing, so other paths reveal nothing.
      const elsewhere = await fetch(new URL("/elsewhere", server.url));
      expect(elsewhere.status).toBe(401);
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "mcp-http with a token file serves clients that send its bearer token",
  async () => {
    const server = await launchMcpHttpServer({ bearerToken: TOKEN });
    const client = await server.spawnClient();
    try {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "bun",
        title: "http-bearer-token",
        cwd: process.cwd(),
      });
      const result = await client.callTool<{ result_text: string }>("exec", {
        session_id: created.session.session_id,
        code: "6 * 7",
      });
      expect(result.result_text).toBe("42");
    } finally {
      await client.close();
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "mcp-http refuses to start with a blank token file",
  () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-mcp-http-token-"));
    try {
      const tokenFile = join(root, "token");
      writeFileSync(tokenFile, "  \n");
      const launch = launchSpec();
      const result = spawnSync(
        launch.command,
        [
          ...launch.args,
          "mcp-http",
          "--port",
          "0",
          "--state-dir",
          join(root, "state"),
          "--token-file",
          tokenFile,
        ],
        // The environment the preload prepared, which names the payload.
        { encoding: "utf8", env: process.env, timeout: TEST_TIMEOUT_MS },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "MCP HTTP bearer token must be non-empty",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
