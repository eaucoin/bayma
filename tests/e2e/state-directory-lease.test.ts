import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpStdioClient } from "../support/mcp-stdio-client.ts";
import { bundlePath, nodeExecutable } from "../support/runtimes.ts";

// The state-directory lease under Node's SQLite binding: the unit test covers
// the binding the test runner has, this covers the one users run.

test.serial(
  "two bundled servers cannot share one state directory",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-lease-e2e-"));
    const spec = {
      command: nodeExecutable(),
      args: [bundlePath()],
      binaryLabel: "bayma",
    };
    const stateDir = join(root, "state");
    const first = await McpStdioClient.launch(spec, { stateDir });
    try {
      // The lock's journal is in memory, never a file beside it.
      expect(
        existsSync(join(stateDir, ".bayma-state-lease.sqlite-journal")),
      ).toBe(false);
      await expect(McpStdioClient.launch(spec, { stateDir })).rejects.toThrow(
        /already in use|Connection closed/,
      );
    } finally {
      await first.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
