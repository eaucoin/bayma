import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStdioClient } from "../../support/mcp-stdio-client.ts";
import { runSandboxHookCommand } from "../../support/runtimes.ts";

const TEST_TIMEOUT_MS = 30_000;

test(
  "mcp-stdio hears the sandbox hook, and tells a session's next exec of the restore",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-stdio-hook-"));
    const stateDir = join(root, "state");
    const client = await McpStdioClient.connect({ stateDir });
    try {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "bun",
        title: "stdio-hook",
        cwd: process.cwd(),
      });
      for (const mode of ["save", "restore"])
        expect(
          await runSandboxHookCommand(stateDir, mode, "arguments"),
        ).toEqual({ status: 0, stderr: "" });

      const told = await client.callTool<{
        result_text: string;
        notice?: string;
      }>("exec", { session_id: created.session.session_id, code: "6 * 7" });
      expect(told.result_text).toBe("42");
      expect(told.notice).toStartWith(
        "bayma: this session came back whole with bayma's sandbox",
      );
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
