import { expect, test } from "bun:test";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";

const EXEC_SETTLE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

test(
  "dotnet-script renders readable results and captures console channels",
  async () => {
    await withMcpStdio(async (client) => {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "dotnet-script",
        title: "dotnet-readable-results",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;

      const arrayExec = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: "Enumerable.Range(1, 3).Select(x => x * 2).ToArray()",
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect(arrayExec.result_text ?? "").toContain("int[3] { 2, 4, 6 }");
      expect(arrayExec.result_text ?? "").not.toContain("System.Int32[]");
      expect(arrayExec.stdout_text ?? "").toBe("");

      const objectExec = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: 'new { Name = "Emile", Answer = 42 }',
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect(objectExec.result_text ?? "").toContain("Name = ");
      expect(objectExec.result_text ?? "").toContain("Answer = 42");
      expect(objectExec.result_text ?? "").not.toContain("<>f__AnonymousType");

      const channelExec = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: [
            'Console.WriteLine("dotnet-out")',
            'Console.Error.WriteLine("dotnet-err")',
            'new { Name = "Emile", Answer = 7 }',
          ].join("\n"),
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect(channelExec.stdout_text ?? "").toContain("dotnet-out");
      expect(channelExec.stderr_text ?? "").toContain("dotnet-err");
      expect(channelExec.result_text ?? "").toContain('Name = "Emile"');
      expect(channelExec.result_text ?? "").toContain("Answer = 7");
      expect(channelExec.result_text ?? "").not.toContain("<>f__AnonymousType");

      const formattedConsoleExec = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: [
            'Console.WriteLine("formatted {0} {1}", 42, "value")',
            "43",
          ].join("\n"),
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect(formattedConsoleExec.status).toBe("ok");
      expect(formattedConsoleExec.stdout_text ?? "").toContain(
        "formatted 42 value",
      );
      expect(formattedConsoleExec.result_text ?? "").toContain("43");

      const fullyQualifiedChannelExec = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: [
            'System.Console.WriteLine("dotnet-fq-out")',
            'System.Console.Error.WriteLine("dotnet-fq-err")',
            "(42, new[] { 2, 4, 6 })",
          ].join("\n"),
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect(fullyQualifiedChannelExec.stdout_text ?? "").toContain(
        "dotnet-fq-out",
      );
      expect(fullyQualifiedChannelExec.stderr_text ?? "").toContain(
        "dotnet-fq-err",
      );
      expect(fullyQualifiedChannelExec.result_text ?? "").toContain(
        "(42, int[3] { 2, 4, 6 })",
      );
      expect(fullyQualifiedChannelExec.result_text ?? "").not.toContain(
        "System.Int32[]",
      );

      const normalizedRuntimeFailure = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: [
            "var normalizedBeforeFailure = 41",
            'throw new InvalidOperationException("normalized-runtime-failure");',
          ].join("\n"),
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect(normalizedRuntimeFailure.status).toBe("error");
      expect(normalizedRuntimeFailure.error_text ?? "").toContain(
        "normalized-runtime-failure",
      );
      expect(normalizedRuntimeFailure.error_text ?? "").not.toContain("CS1002");

      await client.callTool("session.close", { session_id: sessionId });
    });
  },
  TEST_TIMEOUT_MS,
);
