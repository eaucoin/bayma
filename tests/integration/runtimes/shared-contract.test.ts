import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";
import {
  RUNTIME_OUTPUT_CAPTURE_POLICY,
  assertDoctorExecResult,
  type ExecRecord,
} from "@bayma/core";
import {
  PYTHON_STREAM_CONTRACT_STDERR,
  PYTHON_STREAM_CONTRACT_STDOUT,
  pythonStreamContractProbe,
} from "../../support/python-stream-contract.ts";

interface RuntimeScenario {
  runtimeId: RuntimeId;
  seedCode: string;
  asyncCode: string;
  stateCode: string;
  largeOutputCode: string;
  splitUtf8OutputCode: string;
}

interface CriticalToolContract {
  annotations: {
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

const EXEC_SETTLE_TIMEOUT_MS = 90_000;
const RUNTIME_CONTRACT_TEST_TIMEOUT_MS = 240_000;

const RUNTIME_SCENARIOS: RuntimeScenario[] = [
  {
    runtimeId: "bun",
    seedCode: "const keep = 41",
    asyncCode: "await Bun.sleep(10);\n40 + 2",
    stateCode: "keep + 1",
    largeOutputCode: 'process.stdout.write("x".repeat(1_000_000)); 40 + 2',
    splitUtf8OutputCode:
      "process.stdout.write(Buffer.from([0xe2])); process.stdout.write(Buffer.from([0x82, 0xac, 0x0a])); void 0",
  },
  {
    runtimeId: "python",
    seedCode: "keep = 41",
    asyncCode: "import asyncio\nawait asyncio.sleep(0.01)\n40 + 2",
    stateCode: "keep + 1",
    largeOutputCode: 'print("x" * 200_000, end="")\n40 + 2',
    splitUtf8OutputCode:
      "import sys\nsys.stdout.buffer.write(bytes([0xe2]))\nsys.stdout.buffer.write(bytes([0x82, 0xac, 0x0a]))\nNone",
  },
  {
    runtimeId: "dotnet-script",
    seedCode: "var keep = 41;",
    asyncCode: "await System.Threading.Tasks.Task.Delay(10);\n40 + 2",
    stateCode: "keep + 1",
    largeOutputCode:
      "System.Console.Write(new string('x', 1_000_000));\n40 + 2",
    splitUtf8OutputCode: 'System.Console.Write("€\\n");\nnull',
  },
  {
    runtimeId: "rust",
    seedCode: "let keep = 41;",
    asyncCode: "async { 40 + 2 }.await",
    stateCode: "keep + 1",
    largeOutputCode: 'println!("{}", "x".repeat(200_000)); 40 + 2',
    splitUtf8OutputCode: 'print!("€\\n");',
  },
  {
    runtimeId: "lean",
    seedCode: "def keep := 41",
    asyncCode: "#eval (Task.spawn fun _ => 40 + 2).get",
    stateCode: "#eval keep + 1",
    largeOutputCode:
      "#eval do\n  IO.print (\"\".pushn 'x' 200000)\n  return 40 + 2",
    // A cell's last info message is its result, and earlier ones its output.
    splitUtf8OutputCode: '#eval IO.println "€"\n#eval 1',
  },
  {
    runtimeId: "go",
    seedCode: "keep := 41",
    asyncCode:
      "answer := make(chan int)\ngo func() { answer <- 40 + 2 }()\n<-answer",
    stateCode: "keep + 1",
    largeOutputCode:
      'import (\n\t"fmt"\n\t"strings"\n)\nfmt.Print(strings.Repeat("x", 200_000))\n40 + 2',
    splitUtf8OutputCode:
      'import "os"\nos.Stdout.Write([]byte{0xe2})\nos.Stdout.Write([]byte{0x82, 0xac, 0x0a})',
  },
];

function doctorExec(
  resultTexts: string[],
  status: ExecRecord["status"] = "ok",
): ExecRecord {
  return {
    execId: "exec_doctor_fixture",
    code: "40 + 2",
    status,
    submittedAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 2,
    durationMs: 1,
    messages: resultTexts.map((text, index) => ({
      seq: index + 1,
      messageId: `exec_doctor_fixture_${index + 1}`,
      kind: "result",
      text,
      occurredAtMs: 2,
    })),
  };
}

test("runtime doctors require one exact result", () => {
  expect(() => assertDoctorExecResult(doctorExec(["42"]), "42")).not.toThrow();
  expect(() => assertDoctorExecResult(doctorExec(["142"]), "42")).toThrow(
    "exact expected result",
  );
  expect(() => assertDoctorExecResult(doctorExec(["42", "42"]), "42")).toThrow(
    "exact expected result",
  );
  expect(() =>
    assertDoctorExecResult(doctorExec(["42"], "error"), "42"),
  ).toThrow("ended with status error");
});

test(
  "Python redirected streams satisfy the terminal-reporter contract",
  async () => {
    await withMcpStdio(async (client) => {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "python",
        title: "python-stream-contract",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      const exec = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: [pythonStreamContractProbe(), "40 + 2"].join("\n"),
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );

      expect(exec.status).toBe("ok");
      expect(exec.stdout_text).toBe(PYTHON_STREAM_CONTRACT_STDOUT);
      expect(exec.stderr_text).toBe(PYTHON_STREAM_CONTRACT_STDERR);
      expect(exec.result_text).toBe("42");
      expect(exec.error_text ?? "").toBe("");
      await client.callTool("session.close", { session_id: sessionId });
    });
  },
  RUNTIME_CONTRACT_TEST_TIMEOUT_MS,
);

test(
  "every runtime is served through the same tools and resource templates",
  async () => {
    const observed = new Map<
      RuntimeId,
      {
        tools: string[];
        resourceTemplates: string[];
        criticalTools: Record<string, CriticalToolContract>;
      }
    >();

    for (const scenario of RUNTIME_SCENARIOS) {
      await withMcpStdio(async (client) => {
        const toolDefinitions = await client.listToolDefinitions();
        const criticalTools = Object.fromEntries(
          ["exec", "session.close"].map((name) => {
            const tool = toolDefinitions.find(
              (candidate) => candidate.name === name,
            );
            if (!tool) {
              throw new Error(`missing expected tool ${name}`);
            }
            return [
              name,
              {
                annotations: tool.annotations ?? {},
              },
            ];
          }),
        );

        observed.set(scenario.runtimeId, {
          tools: toolDefinitions.map((tool) => tool.name).sort(),
          resourceTemplates: (await client.listResourceTemplates()).sort(),
          criticalTools,
        });
      });
    }

    const bun = observed.get("bun");
    expect(bun).toBeDefined();
    for (const scenario of RUNTIME_SCENARIOS) {
      expect(observed.get(scenario.runtimeId)).toEqual(bun);
      expect(
        observed.get(scenario.runtimeId)?.criticalTools["exec"].annotations
          .destructiveHint,
      ).toBe(true);
      expect(
        observed.get(scenario.runtimeId)?.criticalTools["exec"].annotations
          .openWorldHint,
      ).toBe(true);
      expect(
        observed.get(scenario.runtimeId)?.criticalTools["session.close"]
          .annotations.destructiveHint,
      ).toBe(true);
    }
  },
  RUNTIME_CONTRACT_TEST_TIMEOUT_MS,
);

test(
  "Rust ignores ambient EVcxR startup configuration",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "bayma-rust-ambient-config-"));
    try {
      writeFileSync(join(cwd, "evcxr.toml"), "this is not valid TOML", "utf8");
      await withMcpStdio(async (client) => {
        const created = await client.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: "rust",
          title: "rust-ignores-ambient-config",
          cwd,
        });
        const sessionId = created.session.session_id;
        const exec = await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: "40 + 2",
            yield_time_ms: 1_000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(exec.status).toBe("ok");
        expect(exec.result_text).toContain("42");
        await client.callTool("session.close", { session_id: sessionId });
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  RUNTIME_CONTRACT_TEST_TIMEOUT_MS,
);

test(
  "Rust tool and cache authority cannot be replaced after startup",
  async () => {
    await withMcpStdio(async (client) => {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "rust",
        title: "rust-linker-authority",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      for (const code of [
        ":env BAYMA_RUST_LINKER_BIN=/bayma-intentionally-missing-linker",
        ":build_env RUSTC_WRAPPER=/bayma-intentionally-missing-wrapper",
        ":toolchain stable",
        ":linker lld",
        ":cache 513",
        ":load_config",
      ]) {
        const rejected = await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code,
            yield_time_ms: 1_000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(rejected.status).toBe("error");
        expect(rejected.error_text).toContain("Bayma");
      }

      const compiled = await waitForSettledExec(
        client,
        sessionId,
        await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: "40 + 2",
          yield_time_ms: 1_000,
        }),
        { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
      );
      expect(compiled.status).toBe("ok");
      expect(compiled.result_text).toContain("42");
      await client.callTool("session.close", { session_id: sessionId });
    });
  },
  RUNTIME_CONTRACT_TEST_TIMEOUT_MS,
);

test(
  "Rust idle output cannot attach to a later compilation",
  async () => {
    await withMcpStdio(async (client) => {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: "rust",
        title: "rust-idle-output-fence",
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      const submit = async (code: string): Promise<ExecSnapshot> =>
        await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code,
            yield_time_ms: 1_000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );

      const first = await submit(
        [
          "std::thread::spawn(|| {",
          "    std::thread::sleep(std::time::Duration::from_millis(10));",
          '    println!("late-from-first");',
          "});",
          "1_i64",
        ].join("\n"),
      );
      const second = await submit(
        [
          "struct BaymaOutputFenceProbe(i64);",
          'println!("EVCXR_EXECUTION_STARTED");',
          'println!("EVCXR_EXECUTION_COMPLETE");',
          'println!("EVCXR_PANIC_NOTIFICATION");',
          'println!("EVCXR_ERROR_OCCURRED");',
          'println!("EVCXR_VARIABLE_CHANGED_TYPE:probe");',
          'println!("EVCXR_BEGIN_CONTENT text/plain");',
          'println!("EVCXR_INPUT_REQUEST:probe");',
          'eprintln!("EVCXR_STDERR_COMPLETE aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");',
          'println!("second-only");',
          "BaymaOutputFenceProbe(2).0",
        ].join("\n"),
      );
      const questionMark = await submit(
        [
          "fn bayma_question_mark_probe() -> Result<i64, &'static str> {",
          '    Err("question-mark-evidence")',
          "}",
          "bayma_question_mark_probe()?;",
          "42_i64",
        ].join("\n"),
      );
      const asyncQuestionMark = await submit(
        [
          "async fn bayma_async_question_mark_probe() -> Result<i64, &'static str> {",
          '    Err("async-question-mark-evidence")',
          "}",
          "bayma_async_question_mark_probe().await?;",
          "84_i64",
        ].join("\n"),
      );

      expect(first.status).toBe("ok");
      expect(first.stdout_text ?? "").not.toContain("late-from-first");
      expect(second.status).toBe("ok");
      expect(second.stdout_text ?? "").toContain("EVCXR_EXECUTION_STARTED");
      expect(second.stdout_text ?? "").toContain("EVCXR_EXECUTION_COMPLETE");
      expect(second.stdout_text ?? "").toContain("EVCXR_PANIC_NOTIFICATION");
      expect(second.stdout_text ?? "").toContain("EVCXR_ERROR_OCCURRED");
      expect(second.stdout_text ?? "").toContain(
        "EVCXR_VARIABLE_CHANGED_TYPE:probe",
      );
      expect(second.stdout_text ?? "").toContain(
        "EVCXR_BEGIN_CONTENT text/plain",
      );
      expect(second.stdout_text ?? "").toContain("EVCXR_INPUT_REQUEST:probe");
      expect(second.stderr_text ?? "").toContain(
        "EVCXR_STDERR_COMPLETE aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );
      expect(second.stdout_text ?? "").toContain("second-only");
      expect(second.stdout_text ?? "").not.toContain("late-from-first");
      expect(questionMark.status).toBe("error");
      expect(questionMark.stderr_text ?? "").toContain(
        "question-mark-evidence",
      );
      expect(questionMark.error_text ?? "").toContain("returned early with ?");
      expect(asyncQuestionMark.status).toBe("error");
      expect(asyncQuestionMark.stderr_text ?? "").toContain(
        "async-question-mark-evidence",
      );
      expect(asyncQuestionMark.error_text ?? "").toContain(
        "returned early with ?",
      );
      await client.callTool("session.close", { session_id: sessionId });
    });
  },
  RUNTIME_CONTRACT_TEST_TIMEOUT_MS,
);

for (const scenario of RUNTIME_SCENARIOS) {
  test(
    `${scenario.runtimeId} preserves state and supports async execs`,
    async () => {
      await withMcpStdio(async (client) => {
        const created = await client.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: scenario.runtimeId,
          title: `${scenario.runtimeId}-contract`,
          cwd: process.cwd(),
        });
        const sessionId = created.session.session_id;

        const seeded = await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: scenario.seedCode,
            yield_time_ms: 1000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(seeded.status).toBe("ok");

        const asyncExec = await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: scenario.asyncCode,
            yield_time_ms: 1000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(asyncExec.status).toBe("ok");
        expect(asyncExec.result_text ?? "").toContain("42");

        const stateExec = await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: scenario.stateCode,
            yield_time_ms: 1000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(stateExec.status).toBe("ok");
        expect(stateExec.result_text ?? "").toContain("42");

        const largeOutput = await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: scenario.largeOutputCode,
            yield_time_ms: 1_000,
            max_output_tokens: 20_000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(largeOutput.status).toBe("ok");
        expect(largeOutput.result_text ?? "").toContain("42");
        const runtimeMessageWasTruncated = (
          largeOutput.stdout_text ?? ""
        ).includes("Bayma truncated runtime message");
        const snapshotWasTruncated =
          largeOutput.truncated === true &&
          (largeOutput.stdout_text ?? "").includes("tokens truncated");
        expect(runtimeMessageWasTruncated || snapshotWasTruncated).toBe(true);
        expect(
          Buffer.byteLength(largeOutput.stdout_text ?? "", "utf8"),
        ).toBeLessThanOrEqual(RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessageBytes);

        const splitUtf8Output = await waitForSettledExec(
          client,
          sessionId,
          await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: scenario.splitUtf8OutputCode,
            yield_time_ms: 1_000,
          }),
          { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
        );
        expect(splitUtf8Output.status).toBe("ok");
        expect(splitUtf8Output.stdout_text).toBe("€\n");

        await client.callTool("session.close", { session_id: sessionId });
      });
    },
    RUNTIME_CONTRACT_TEST_TIMEOUT_MS,
  );
}
