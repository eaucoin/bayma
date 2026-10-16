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

// A C# host keeps every cell it compiled: past the server's runtime memory
// budget, as a host whose first cell compiles and holds 256 MiB is past one of
// 96 MiB, it is started again from the session's checkpoint once an exec has
// ended, and the next exec told why; restored, compiling the cell that restores
// the checkpoint, it holds less past its start than the budget, as it holds
// some 30 MiB.
test(
  "a dotnet-script host past the runtime memory budget is started again from its checkpoint, the next exec told why",
  async () => {
    await withMcpStdio(
      async (client) => {
        const created = await client.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: "dotnet-script",
          title: "dotnet-memory-budget",
          cwd: process.cwd(),
        });
        const sessionId = created.session.session_id;
        const exec = async (code: string) =>
          waitForSettledExec(
            client,
            sessionId,
            await client.callTool<ExecSnapshot>("exec", {
              session_id: sessionId,
              code,
              yield_time_ms: 1_000,
            }),
            { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
          );
        const pid = "System.Environment.ProcessId";
        const first = await exec(
          `bayma_write_checkpoint(41); var held = new byte[256 << 20]; System.Array.Fill(held, (byte)1); ${pid}`,
        );
        expect(first.notice).toBeUndefined();
        const second = await exec(
          `$"{bayma_read_checkpoint<int>() + 1} {${pid}}"`,
        );
        expect(second.status).toBe("ok");
        expect(second.notice ?? "").toMatch(
          /^bayma: this session's runtime came to hold \d+ MiB more than it held as it started, past the server's runtime memory budget of 96 MiB, as it keeps every cell it compiled, each costing more the longer the session runs, so it was started again from its checkpoint: only its checkpointed state survived, and the rest of its live state is gone\.$/,
        );
        const [answer, secondPid] = (second.result_text ?? "")
          .replaceAll('"', "")
          .trim()
          .split(" ");
        expect(answer).toBe("42");
        expect(secondPid).not.toBe((first.result_text ?? "").trim());
      },
      {
        defaultDurability: "checkpointed",
        serverArgs: ["--runtime-memory-budget-mb", "96"],
      },
    );
  },
  TEST_TIMEOUT_MS,
);
