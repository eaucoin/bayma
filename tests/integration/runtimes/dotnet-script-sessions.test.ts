import { expect, test } from "bun:test";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";

const EXEC_SETTLE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;

/** The result of `code` in the session, as a number. */
async function count(
  client: McpStdioClient,
  sessionId: string,
  code: string,
): Promise<number> {
  const done = await waitForSettledExec(
    client,
    sessionId,
    await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 1_000,
    }),
    { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
  );
  expect(done.status).toBe("ok");
  return Number((done.result_text ?? "").trim());
}

// Roslyn keeps every submission of a session's chain, each costing more the
// longer the chain is: an exec compiles its code alone, and what bayma does
// around it, as it captures the exec's output and checkpoints the session,
// runs in the host.
test(
  "a dotnet-script exec compiles its code alone, its output and checkpoint taken around it by the host",
  async () => {
    await withMcpStdio(async (client) => {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "dotnet-script",
        title: "dotnet-one-submission",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      const loaded = "AppDomain.CurrentDomain.GetAssemblies().Length";
      // Each submission Roslyn compiles is an assembly of its own.
      const counts: number[] = [];
      for (let exec = 0; exec < 6; exec += 1)
        counts.push(await count(client, sessionId, loaded));
      const grown = counts
        .slice(1)
        .map((value, index) => value - counts[index]!);
      expect(grown).toEqual([1, 1, 1, 1, 1]);
      // The exec's output and the session's checkpoint still come through.
      const written = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: 'Console.WriteLine("dotnet-out"); bayma_write_checkpoint(42)',
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect({
        status: written.status,
        stdout: written.stdout_text,
        result: (written.result_text ?? "").trim(),
      }).toEqual({ status: "ok", stdout: "dotnet-out\n", result: "42" });
    });
  },
  TEST_TIMEOUT_MS,
);
