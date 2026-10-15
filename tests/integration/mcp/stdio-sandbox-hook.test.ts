import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_GENERATION_FILE } from "@bayma/core";
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

test(
  "mcp-stdio refuses the restore of a save its state directory has moved on from",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-stdio-hook-"));
    const stateDir = join(root, "state");
    const client = await McpStdioClient.connect({ stateDir });
    try {
      expect(
        await runSandboxHookCommand(stateDir, "save", "arguments"),
      ).toEqual({ status: 0, stderr: "" });
      // The sandbox, saved live, ran on, and told a client of a change.
      const path = join(stateDir, STATE_GENERATION_FILE);
      const { generation } = JSON.parse(readFileSync(path, "utf8")) as {
        generation: number;
      };
      writeFileSync(
        path,
        JSON.stringify({ schemaVersion: 1, generation: generation + 1 }),
      );
      const refused = await runSandboxHookCommand(
        stateDir,
        "restore",
        "arguments",
      );
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain(
        `the state directory has moved on since this save: its generation is ${generation + 1}, and was ${generation} as the sandbox was saved`,
      );
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
