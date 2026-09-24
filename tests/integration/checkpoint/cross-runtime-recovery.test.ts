import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionExecUri } from "@bayma/core";
import {
  waitForSettledExec,
  McpStdioClient,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";

interface RuntimeScenario {
  runtimeId: RuntimeId;
  seedCode: string;
  readCode: string;
  expectedResult: string;
}

const TEST_TIMEOUT_MS = 180_000;

const EXEC_SETTLE_TIMEOUT_MS = 90_000;

const RUNTIME_SCENARIOS: RuntimeScenario[] = [
  {
    runtimeId: "bun",
    seedCode: '$checkpoint = new Map([["answer", 41]]); "seeded"',
    readCode: '$checkpoint.get("answer") + 1',
    expectedResult: "42",
  },
  {
    runtimeId: "python",
    seedCode:
      'bayma_write_checkpoint({"answer": 41, "items": {1, 2, 3}})\n"seeded"',
    readCode: 'bayma_read_checkpoint()["answer"] + 1',
    expectedResult: "42",
  },
  {
    runtimeId: "dotnet-script",
    seedCode:
      'bayma_write_checkpoint(new Dictionary<string, int> { ["answer"] = 41 });\n"seeded"',
    readCode:
      'var checkpoint = bayma_read_checkpoint<Dictionary<string, int>>();\ncheckpoint!["answer"] + 1',
    expectedResult: "42",
  },
  {
    runtimeId: "rust",
    seedCode: [
      'let state: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::from([(String::from("answer"), 41_i64)]);',
      "bayma_rust_support::write_checkpoint(&mut bayma_checkpoint, &state).unwrap();",
      '"seeded"',
    ].join("\n"),
    readCode: [
      "let state: std::collections::BTreeMap<String, i64> = bayma_rust_support::read_checkpoint(&bayma_checkpoint).unwrap().unwrap();",
      'state["answer"] + 1',
    ].join("\n"),
    expectedResult: "42",
  },
  // C and C++ checkpoints are JSON text; bayma hands a recovered session the
  // committed value re-serialized, so the reads parse compact JSON.
  {
    runtimeId: "c",
    seedCode: 'bayma_write_checkpoint("{\\"answer\\": 41}");\n"seeded"',
    readCode: [
      "#include <stdio.h>",
      "int answer = 0;",
      'sscanf(bayma_read_checkpoint(), "{\\"answer\\":%d}", &answer);',
      "answer + 1",
    ].join("\n"),
    expectedResult: "42",
  },
  {
    runtimeId: "cpp",
    seedCode: 'bayma_write_checkpoint(R"({"answer": 41})");\n"seeded"',
    readCode: [
      "#include <cstdio>",
      "int answer = 0;",
      'std::sscanf(bayma_read_checkpoint(), R"({"answer":%d})", &answer);',
      "answer + 1",
    ].join("\n"),
    expectedResult: "42",
  },
  // A Lean checkpoint is the session's environment: what it declared.
  {
    runtimeId: "lean",
    seedCode: 'def answer := 41\n#eval "seeded"',
    readCode: "#eval answer + 1",
    expectedResult: "42",
  },
  {
    runtimeId: "go",
    seedCode: 'bayma_write_checkpoint(map[string]int{"answer": 41})\n"seeded"',
    readCode: [
      "var state map[string]int",
      "bayma_read_checkpoint(&state)",
      'state["answer"] + 1',
    ].join("\n"),
    expectedResult: "42",
  },
];

for (const scenario of RUNTIME_SCENARIOS) {
  test(
    `${scenario.runtimeId} recovers explicit checkpoint state after MCP stdio restart`,
    async () => {
      const root = mkdtempSync(
        join(tmpdir(), `bayma-${scenario.runtimeId}-checkpoint-`),
      );
      const stateDir = join(root, "state");
      let seedClient: McpStdioClient | undefined;
      let recoveryClient: McpStdioClient | undefined;
      try {
        seedClient = await McpStdioClient.connect({
          stateDir,
          defaultDurability: "checkpointed",
        });
        const created = await seedClient.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: scenario.runtimeId,
          title: `${scenario.runtimeId}-checkpoint-recovery`,
          cwd: process.cwd(),
        });
        const sessionId = created.session.session_id;
        const seeded = await waitForSettledExec(
          seedClient,
          sessionId,
          await seedClient.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: scenario.seedCode,
            yield_time_ms: 1000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(seeded.status).toBe("ok");
        await seedClient.close();

        recoveryClient = await McpStdioClient.connect({
          stateDir,
          defaultDurability: "checkpointed",
        });
        await recoveryClient.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        const recovered = await waitForSettledExec(
          recoveryClient,
          sessionId,
          await recoveryClient.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: scenario.readCode,
            yield_time_ms: 1000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(recovered.status).toBe("ok");
        expect(recovered.result_text ?? "").toContain(scenario.expectedResult);

        const exec = await recoveryClient.readJsonResource<{
          exec: {
            status: string;
            messages: Array<{ kind: string; text: string }>;
          };
        }>(sessionExecUri(sessionId, recovered.exec_id));
        expect(exec.exec.status).toBe("ok");
      } finally {
        await seedClient?.close().catch(() => undefined);
        await recoveryClient?.close().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
}
