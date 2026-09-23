import { expect, test } from "bun:test";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";

// The payload environment every session inherits must not carry a runtime's
// own interpreter settings: PYTHONHOME or LD_LIBRARY_PATH there redirects any
// other Python a session starts to bayma's standard library.

const EXEC_SETTLE_TIMEOUT_MS = 90_000;

async function runIn(
  client: McpStdioClient,
  runtime: RuntimeId,
  code: string,
): Promise<ExecSnapshot> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime, title: `${runtime}-environment`, cwd: process.cwd() },
  );
  const sessionId = created.session.session_id;
  try {
    return await waitForSettledExec(
      client,
      sessionId,
      await client.callTool<ExecSnapshot>("exec", {
        session_id: sessionId,
        code,
        yield_time_ms: 1_000,
      }),
      { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
    );
  } finally {
    await client.callTool("session.close", { session_id: sessionId });
  }
}

test("sessions inherit no Python interpreter redirects, and Python still loads its native modules", async () => {
  // The payload the tests' server runs, which the preload names.
  const payload = JSON.stringify(process.env.BAYMA_PAYLOAD_DIR);
  expect(payload).toBeDefined();
  await withMcpStdio(async (client) => {
    const python = await runIn(
      client,
      "python",
      [
        "import os, ssl, sqlite3, ctypes, decimal, contextvars, lzma, zlib",
        `print(sorted(name for name in ('PYTHONHOME', 'PYTHONPATH', 'LD_LIBRARY_PATH') if ${payload} in os.environ.get(name, '')))`,
        "print(decimal.Decimal('1.5') * 2)",
      ].join("\n"),
    );
    expect(python.status).toBe("ok");
    expect(python.stdout_text).toContain("[]");
    expect(python.stdout_text).toContain("3.0");

    const bun = await runIn(
      client,
      "bun",
      `JSON.stringify(['PYTHONHOME', 'LD_LIBRARY_PATH'].filter((name) => process.env[name]?.includes(${payload})))`,
    );
    expect(bun.status).toBe("ok");
    expect(bun.result_text).toContain("[]");
  });
}, 240_000);
