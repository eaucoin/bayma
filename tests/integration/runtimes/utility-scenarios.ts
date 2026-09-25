import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { withMcpHttpServer } from "../../support/mcp-http-client.ts";
import {
  waitForSettledExec,
  withMcpStdio,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";

export interface RuntimeSnapshot {
  exec_id: string;
  session_id: string;
  runtime: RuntimeId;
  status: string;
  done: boolean;
  stdout_text: string;
  stderr_text: string;
  result_text: string;
  error_text: string;
  next_seq: number;
}

export interface RuntimeLatencyMetrics {
  startup_ms: number;
  steady_state_ms: number;
}

export interface RuntimeUtilityScenarioResult {
  id: string;
  ok: boolean;
  duration_ms: number;
  evidence: Record<string, unknown>;
  notes: string[];
}

export interface RuntimeUtilityReport {
  runtimeId: RuntimeId;
  baselineRuntimeId: "bun";
  generatedAt: string;
  launchTarget: string;
  scenarios: RuntimeUtilityScenarioResult[];
  latency: RuntimeLatencyMetrics;
  failures: string[];
  warnings: string[];
  recommendation: "baseline" | "ship-candidate" | "do-not-ship";
}

interface RuntimeSessionContext {
  client: McpStdioClient;
  sessionId: string;
}

const EXEC_SETTLE_TIMEOUT_MS = 45_000;

const STARTUP_LATENCY_FLOOR_MS: Record<Exclude<RuntimeId, "bun">, number> = {
  python: 5_000,
  "dotnet-script": 5_000,
  // A fresh EVcxR context compiles its bootstrap crate and the first submitted
  // cell. That is real user-visible work, but it is not comparable to Bun's
  // parser-only startup floor. Keep a finite ceiling that still catches a
  // material regression on the slowest native release runner or a contended
  // but otherwise healthy clean machine.
  // Intel macOS and Windows native hosts have a materially slower first EVcxR
  // compile than the other release runners. Preserve the 30-second bar on the
  // faster hosts and use a measured, still-finite ceiling for those cold tails.
  rust: 30_000,
  c: 5_000,
  cpp: 5_000,
  lean: 5_000,
  // Each Go session builds its first cells' plugins, and the first on a
  // machine compiles Go's standard library for plugins; like Rust's first
  // compile, real work with a finite ceiling.
  go: 30_000,
};
const STEADY_STATE_LATENCY_FLOOR_MS = 3_000;

interface RuntimeScenarioSpec {
  seed: string;
  state: string;
  multiline: string;
  multilineExpect: string;
  asyncCode: string;
  dependencyFileName: string;
  dependencyFileContent: string;
  dependencyFiles?: Record<string, string>;
  /** Builds the dependency, as its user would, before the session starts. */
  dependencyBuild?: () => string[];
  dependencySetupCode?: string;
  dependencyCode: string;
  channelCode: string;
  errorCode: string;
  errorExpect: string;
  readableResultCode: string;
  readableResultExpect: string[];
  readableResultReject?: string[];
  interruptCode: string;
  /** A cell whose result is 42, where `40 + 2` is not a cell. */
  answerCode?: string;
}

const RUNTIME_SCENARIOS: Record<RuntimeId, RuntimeScenarioSpec> = {
  bun: {
    seed: "const keep = 41;",
    state: "keep + 1",
    multiline: [
      "const describe = (name) => name.toUpperCase();",
      'describe("bayma")',
    ].join("\n"),
    multilineExpect: "BAYMA",
    asyncCode: "await Bun.sleep(10);\n40 + 2",
    dependencyFileName: "helper.ts",
    dependencyFileContent: "export const answer = 42;\n",
    dependencyCode: 'const mod = await import("./helper.ts");\nmod.answer',
    channelCode:
      'console.log("utility-out");\nconsole.error("utility-err");\n7',
    errorCode: 'throw new Error("utility boom");',
    errorExpect: "utility boom",
    readableResultCode: '({ name: "bayma", values: [2, 4, 6] })',
    readableResultExpect: ['name: "bayma"', "values: [ 2, 4, 6 ]"],
    interruptCode: "await Bun.sleep(10000);\n40 + 2",
  },
  python: {
    seed: "keep = 41",
    state: "keep + 1",
    multiline: [
      "describe = lambda name: name.upper()",
      'describe("bayma")',
    ].join("\n"),
    multilineExpect: "BAYMA",
    asyncCode: "import asyncio\nawait asyncio.sleep(0.01)\n40 + 2",
    dependencyFileName: "helper.py",
    dependencyFileContent: "answer = 42\n",
    dependencyCode: "from helper import answer\nanswer",
    channelCode: [
      "import sys",
      'print("utility-out")',
      'print("utility-err", file=sys.stderr)',
      "7",
    ].join("\n"),
    errorCode: 'raise RuntimeError("utility boom")',
    errorExpect: "RuntimeError: utility boom",
    readableResultCode: '{"name": "bayma", "values": [2, 4, 6]}',
    readableResultExpect: ["'name': 'bayma'", "'values': [2, 4, 6]"],
    interruptCode: "import asyncio\nawait asyncio.sleep(10)\n40 + 2",
  },
  "dotnet-script": {
    seed: "var keep = 41;",
    state: "keep + 1",
    multiline: [
      "var values = Enumerable.Range(1, 3).Select(x => x * 2).ToArray()",
      "values",
    ].join("\n"),
    multilineExpect: "int[3] { 2, 4, 6 }",
    asyncCode: "await System.Threading.Tasks.Task.Delay(10);\n40 + 2",
    dependencyFileName: "helper.csx",
    dependencyFileContent: "int Answer() => 42;\n",
    dependencySetupCode: '#load "helper.csx"',
    dependencyCode: "Answer()",
    channelCode: [
      'System.Console.WriteLine("utility-out")',
      'System.Console.Error.WriteLine("utility-err")',
      "7",
    ].join("\n"),
    errorCode: 'throw new System.InvalidOperationException("utility boom");',
    errorExpect: "utility boom",
    readableResultCode: "(42, new[] { 2, 4, 6 })",
    readableResultExpect: ["(42, ", "int[3] { 2, 4, 6 }"],
    readableResultReject: ["System.Int32[]"],
    interruptCode: "await System.Threading.Tasks.Task.Delay(10000);\n40 + 2",
  },
  rust: {
    seed: "let keep: i64 = 41;",
    state: "keep + 1",
    multiline: [
      "fn describe(name: &str) -> String { name.to_uppercase() }",
      'describe("bayma")',
    ].join("\n"),
    multilineExpect: "BAYMA",
    asyncCode: "std::future::ready(42_i64).await",
    dependencyFileName: "helper/Cargo.toml",
    dependencyFileContent: [
      "[package]",
      'name = "helper"',
      'version = "0.0.0"',
      'edition = "2024"',
      "",
      "[lib]",
      'path = "src/lib.rs"',
      "",
    ].join("\n"),
    dependencyFiles: {
      "helper/src/lib.rs": "pub fn answer() -> i64 { 42 }\n",
    },
    dependencySetupCode: ':dep helper = { path = "helper" }',
    dependencyCode: "helper::answer()",
    channelCode: [
      'println!("utility-out");',
      'eprintln!("utility-err");',
      "7_i64",
    ].join("\n"),
    errorCode: 'panic!("utility boom");',
    errorExpect: "Rust execution panicked",
    readableResultCode:
      'std::collections::BTreeMap::from([(String::from("name"), vec![2_i64, 4_i64, 6_i64])])',
    readableResultExpect: ['"name"', "[2, 4, 6]"],
    interruptCode: "loop { std::hint::spin_loop(); }",
  },
  c: {
    seed: "long keep = 41;",
    state: "keep + 1",
    multiline: [
      "#include <ctype.h>",
      "#include <stddef.h>",
      "const char *describe(const char *name) {",
      "  static char upper[64];",
      "  size_t i = 0;",
      "  for (; name[i] && i + 1 < sizeof upper; ++i)",
      "    upper[i] = (char)toupper((unsigned char)name[i]);",
      "  upper[i] = '\\0';",
      "  return upper;",
      "}",
      'describe("bayma")',
    ].join("\n"),
    multilineExpect: "BAYMA",
    asyncCode: [
      "#include <pthread.h>",
      "void *work(void *arg) { (void)arg; return (void *)42; }",
      "pthread_t worker;",
      "void *answer;",
      "pthread_create(&worker, 0, work, 0);",
      "pthread_join(worker, &answer);",
      "(long)answer",
    ].join("\n"),
    dependencyFileName: "helper.h",
    dependencyFileContent: "static inline int answer(void) { return 42; }\n",
    dependencySetupCode: '#include "helper.h"',
    dependencyCode: "answer()",
    channelCode: [
      "#include <stdio.h>",
      'puts("utility-out");',
      'fputs("utility-err\\n", stderr);',
      "7",
    ].join("\n"),
    errorCode: "int broken = undeclared_name;",
    errorExpect: "use of undeclared identifier 'undeclared_name'",
    readableResultCode: "int values[3] = {2, 4, 6};\nvalues",
    readableResultExpect: ["{ 2, 4, 6 }"],
    interruptCode: "volatile unsigned long spin = 0;\nwhile (1) ++spin;",
  },
  cpp: {
    seed: "long keep = 41;",
    state: "keep + 1",
    multiline: [
      "#include <algorithm>",
      "#include <cctype>",
      "#include <string>",
      "std::string describe(std::string name) {",
      "  std::ranges::transform(name, name.begin(), [](unsigned char c) {",
      "    return static_cast<char>(std::toupper(c));",
      "  });",
      "  return name;",
      "}",
      'describe("bayma")',
    ].join("\n"),
    multilineExpect: '"BAYMA"',
    asyncCode: [
      "#include <future>",
      "int answer() { return 42; }",
      "std::async(std::launch::async, answer).get()",
    ].join("\n"),
    dependencyFileName: "helper.h",
    dependencyFileContent: "inline int answer() { return 42; }\n",
    dependencySetupCode: '#include "helper.h"',
    dependencyCode: "answer()",
    channelCode: [
      "#include <cstdio>",
      'std::puts("utility-out");',
      'std::fputs("utility-err\\n", stderr);',
      "7",
    ].join("\n"),
    errorCode:
      '#include <stdexcept>\nthrow std::runtime_error("utility boom");',
    errorExpect: "uncaught exception: utility boom",
    readableResultCode: [
      "#include <map>",
      "#include <string>",
      "#include <vector>",
      'std::map<std::string, std::vector<int>>{{"name", {2, 4, 6}}}',
    ].join("\n"),
    readableResultExpect: ['"name"', "[2, 4, 6]"],
    readableResultReject: ["@0x"],
    interruptCode: "volatile unsigned long spin = 0;\nwhile (true) ++spin;",
  },
  lean: {
    seed: "def keep := 41",
    state: "#eval keep + 1",
    multiline: [
      "def describe (name : String) : String := name.toUpper",
      '#eval describe "bayma"',
    ].join("\n"),
    multilineExpect: "BAYMA",
    asyncCode: "#eval (Task.spawn fun _ => 40 + 2).get",
    dependencyFileName: "lakefile.toml",
    dependencyFileContent: [
      'name = "helper"',
      'defaultTargets = ["Helper"]',
      "",
      "[[lean_lib]]",
      'name = "Helper"',
      "",
    ].join("\n"),
    dependencyFiles: {
      "lean-toolchain": `leanprover/lean4:v${process.env.BAYMA_LEAN_VERSION}\n`,
      "Helper.lean": "def Helper.answer : Nat := 42\n",
    },
    dependencyBuild: () => [process.env.BAYMA_LAKE_BIN!, "build"],
    dependencyCode: "import Helper\n#eval Helper.answer",
    channelCode: [
      "#eval do",
      '  IO.println "utility-out"',
      '  IO.eprintln "utility-err"',
      "  return 7",
    ].join("\n"),
    errorCode: '#eval (throw (IO.userError "utility boom") : IO Unit)',
    errorExpect: "utility boom",
    readableResultCode: '#eval ("bayma", [2, 4, 6])',
    readableResultExpect: ['"bayma"', "[2, 4, 6]"],
    interruptCode: [
      "#eval Id.run do",
      "  let mut total := 0",
      "  for i in [0:1000000000] do total := total + i",
      "  return total",
    ].join("\n"),
    answerCode: "#eval 40 + 2",
  },
  go: {
    seed: "keep := 41",
    state: "keep + 1",
    multiline: [
      'import "strings"',
      "func describe(name string) string { return strings.ToUpper(name) }",
      'describe("bayma")',
    ].join("\n"),
    multilineExpect: "BAYMA",
    asyncCode: [
      "answer := make(chan int)",
      "go func() { answer <- 40 + 2 }()",
      "<-answer",
    ].join("\n"),
    dependencyFileName: "go.mod",
    dependencyFileContent: "module helper\n\ngo 1.26\n",
    dependencyFiles: {
      "answer/answer.go": "package answer\n\nfunc Value() int { return 42 }\n",
    },
    dependencyCode: 'import "helper/answer"\nanswer.Value()',
    channelCode: [
      "import (",
      '\t"fmt"',
      '\t"os"',
      ")",
      'fmt.Println("utility-out")',
      'fmt.Fprintln(os.Stderr, "utility-err")',
      "7",
    ].join("\n"),
    errorCode: 'panic("utility boom")',
    errorExpect: "utility boom",
    readableResultCode: 'map[string][]int{"name": {2, 4, 6}}',
    readableResultExpect: ["name", "[2 4 6]"],
    interruptCode: "for {\n}",
  },
};

export async function runRuntimeUtilityReport(
  runtimeId: RuntimeId,
  baseline?: RuntimeLatencyMetrics,
): Promise<RuntimeUtilityReport> {
  const scenarios: RuntimeUtilityScenarioResult[] = [];
  scenarios.push(await runStatePersistence(runtimeId));
  scenarios.push(await runMultiline(runtimeId));
  scenarios.push(await runAsync(runtimeId));
  scenarios.push(await runDependencyWorkflow(runtimeId));
  scenarios.push(await runChannelSeparation(runtimeId));
  scenarios.push(await runErrorReadability(runtimeId));
  scenarios.push(await runResultReadability(runtimeId));
  scenarios.push(await runInterruptRecovery(runtimeId));
  scenarios.push(await runReconnect(runtimeId));

  let latency: RuntimeLatencyMetrics = {
    startup_ms: 0,
    steady_state_ms: 0,
  };
  let latencyMeasured = false;
  const latencyStarted = performance.now();
  try {
    latency = await measureLatency(runtimeId);
    latencyMeasured = true;
  } catch (error) {
    scenarios.push({
      id: "latency_measurement",
      ok: false,
      duration_ms: Math.round(performance.now() - latencyStarted),
      evidence: {
        error:
          error instanceof Error ? error.stack || error.message : String(error),
      },
      notes: ["latency measurement failed before producing metrics"],
    });
  }
  const warnings: string[] = [];

  if (baseline && runtimeId !== "bun" && latencyMeasured) {
    const startupBudget = Math.max(
      STARTUP_LATENCY_FLOOR_MS[runtimeId],
      baseline.startup_ms * 10,
    );
    const steadyBudget = Math.max(
      STEADY_STATE_LATENCY_FLOOR_MS,
      baseline.steady_state_ms * 10,
    );
    if (latency.startup_ms > startupBudget) {
      warnings.push(
        `startup latency ${latency.startup_ms}ms exceeded budget ${startupBudget}ms`,
      );
    }
    if (latency.steady_state_ms > steadyBudget) {
      warnings.push(
        `steady-state latency ${latency.steady_state_ms}ms exceeded budget ${steadyBudget}ms`,
      );
    }
  }

  const failures = scenarios
    .filter((scenario) => !scenario.ok)
    .map((scenario) => scenario.id);
  const recommendation =
    runtimeId === "bun"
      ? "baseline"
      : failures.length === 0 && warnings.length === 0
        ? "ship-candidate"
        : "do-not-ship";

  return {
    runtimeId,
    baselineRuntimeId: "bun",
    generatedAt: new Date().toISOString(),
    launchTarget: process.env.BAYMA_REPL_BINARY ?? "source-cli",
    scenarios,
    latency,
    failures,
    warnings,
    recommendation,
  };
}

async function runStatePersistence(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("state_persistence", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withRuntimeSession(
      runtimeId,
      process.cwd(),
      async ({ client, sessionId }) => {
        await execSubmit(client, sessionId, spec.seed);
        const state = await execSubmit(client, sessionId, spec.state);
        return {
          ok: state.result_text.includes("42"),
          evidence: {
            result_text: state.result_text,
          },
          notes: ["scenario completed"],
        };
      },
    );
  });
}

async function runMultiline(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("multiline_submission", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withRuntimeSession(
      runtimeId,
      process.cwd(),
      async ({ client, sessionId }) => {
        const result = await execSubmit(client, sessionId, spec.multiline);
        return {
          ok: result.result_text.includes(spec.multilineExpect),
          evidence: {
            status: result.status,
            result_text: result.result_text,
            error_text: result.error_text,
          },
          notes: ["scenario completed"],
        };
      },
    );
  });
}

async function runAsync(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("async_exec", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withRuntimeSession(
      runtimeId,
      process.cwd(),
      async ({ client, sessionId }) => {
        const result = await execSubmit(client, sessionId, spec.asyncCode);
        return {
          ok: result.status === "ok" && result.result_text.includes("42"),
          evidence: {
            status: result.status,
            result_text: result.result_text,
          },
          notes: ["scenario completed"],
        };
      },
    );
  });
}

async function runDependencyWorkflow(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("cwd_dependency_workflow", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    const root = mkdtempSync(join(tmpdir(), `bayma-utility-${runtimeId}-`));
    mkdirSync(root, { recursive: true });
    for (const [name, content] of Object.entries({
      [spec.dependencyFileName]: spec.dependencyFileContent,
      ...spec.dependencyFiles,
    })) {
      const path = join(root, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, "utf8");
    }
    if (spec.dependencyBuild) {
      const built = spawnSync(
        spec.dependencyBuild()[0]!,
        spec.dependencyBuild().slice(1),
        {
          cwd: root,
          encoding: "utf8",
        },
      );
      if (built.status !== 0)
        throw new Error(
          `building the dependency failed: ${built.stdout}${built.stderr}`,
        );
    }
    try {
      return await withRuntimeSession(
        runtimeId,
        root,
        async ({ client, sessionId }) => {
          if (spec.dependencySetupCode) {
            await execSubmit(client, sessionId, spec.dependencySetupCode);
          }
          const result = await execSubmit(
            client,
            sessionId,
            spec.dependencyCode,
          );
          return {
            ok: result.result_text.includes("42"),
            evidence: {
              cwd: root,
              result_text: result.result_text,
            },
            notes: ["scenario completed"],
          };
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

async function runChannelSeparation(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("channel_separation", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withRuntimeSession(
      runtimeId,
      process.cwd(),
      async ({ client, sessionId }) => {
        const result = await execSubmit(client, sessionId, spec.channelCode);
        return {
          ok:
            result.stdout_text.includes("utility-out") &&
            result.stderr_text.includes("utility-err") &&
            result.result_text.includes("7"),
          evidence: {
            status: result.status,
            stdout_text: result.stdout_text,
            stderr_text: result.stderr_text,
            result_text: result.result_text,
            error_text: result.error_text,
          },
          notes: ["scenario completed"],
        };
      },
    );
  });
}

async function runErrorReadability(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("error_readability", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withRuntimeSession(
      runtimeId,
      process.cwd(),
      async ({ client, sessionId }) => {
        const result = await execSubmit(client, sessionId, spec.errorCode);
        return {
          ok:
            result.status === "error" &&
            result.error_text.includes(spec.errorExpect),
          evidence: {
            status: result.status,
            error_text: result.error_text,
          },
          notes: ["scenario completed"],
        };
      },
    );
  });
}

async function runResultReadability(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("result_readability", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withRuntimeSession(
      runtimeId,
      process.cwd(),
      async ({ client, sessionId }) => {
        const result = await execSubmit(
          client,
          sessionId,
          spec.readableResultCode,
        );
        return {
          ok:
            result.status === "ok" &&
            spec.readableResultExpect.every((text) =>
              result.result_text.includes(text),
            ) &&
            (spec.readableResultReject ?? []).every(
              (text) => !result.result_text.includes(text),
            ),
          evidence: {
            status: result.status,
            result_text: result.result_text,
          },
          notes: ["scenario completed"],
        };
      },
    );
  });
}

async function runInterruptRecovery(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("interrupt_recovery", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withRuntimeSession(
      runtimeId,
      process.cwd(),
      async ({ client, sessionId }) => {
        const started = await client.callTool<RuntimeSnapshot>("exec", {
          session_id: sessionId,
          code: spec.interruptCode,
          yield_time_ms: 25,
        });
        await client.callTool("session.interrupt", { session_id: sessionId });
        const interrupted = await client.callTool<RuntimeSnapshot>("wait", {
          session_id: sessionId,
          exec_id: started.exec_id,
          from_seq: started.next_seq,
          yield_time_ms: 250,
        });
        const recovery = await execSubmit(
          client,
          sessionId,
          spec.answerCode ?? "40 + 2",
        );
        return {
          ok:
            interrupted.status === "interrupted" &&
            recovery.status === "ok" &&
            recovery.result_text.includes("42"),
          evidence: {
            interrupt_status: interrupted.status,
            recovery_status: recovery.status,
            recovery_result: recovery.result_text,
          },
          notes: ["scenario completed"],
        };
      },
    );
  });
}

async function runReconnect(
  runtimeId: RuntimeId,
): Promise<RuntimeUtilityScenarioResult> {
  return await runScenario("http_reconnect_state", async () => {
    const spec = RUNTIME_SCENARIOS[runtimeId];
    return await withMcpHttpServer(async ({ client, spawnClient }) => {
      const created = await client.callTool<{
        session: { session_id: string };
      }>("session.create", {
        runtime: runtimeId,
        title: `${runtimeId}-utility-reconnect`,
        cwd: process.cwd(),
      });
      const sessionId = created.session.session_id;
      try {
        await execSubmit(client, sessionId, spec.seed);
        await client.close();
        const reconnect = await spawnClient();
        try {
          await reconnect.callTool("session.acquire_controller", {
            session_id: sessionId,
          });
          const state = await execSubmit(reconnect, sessionId, spec.state);
          return {
            ok: state.result_text.includes("42"),
            evidence: {
              result_text: state.result_text,
            },
            notes: ["scenario completed"],
          };
        } finally {
          await reconnect
            .callTool("session.close", { session_id: sessionId })
            .catch(() => undefined);
          await reconnect.close();
        }
      } catch (error) {
        return {
          ok: false,
          evidence: {
            error: error instanceof Error ? error.message : String(error),
          },
          notes: ["scenario completed"],
        };
      }
    });
  });
}

async function measureLatency(
  runtimeId: RuntimeId,
): Promise<RuntimeLatencyMetrics> {
  return await withMcpStdio(async (client) => {
    const startupStarted = performance.now();
    const created = await client.callTool<{ session: { session_id: string } }>(
      "session.create",
      {
        runtime: runtimeId,
        title: `${runtimeId}-latency`,
        cwd: process.cwd(),
      },
    );
    const sessionId = created.session.session_id;
    const answer = RUNTIME_SCENARIOS[runtimeId].answerCode ?? "40 + 2";
    try {
      await execSubmit(client, sessionId, answer);
      const startupMs = Math.round(performance.now() - startupStarted);

      const steadyStarted = performance.now();
      await execSubmit(client, sessionId, answer);
      const steadyStateMs = Math.round(performance.now() - steadyStarted);

      return {
        startup_ms: startupMs,
        steady_state_ms: steadyStateMs,
      };
    } finally {
      await client
        .callTool("session.close", { session_id: sessionId })
        .catch(() => undefined);
    }
  });
}

async function withRuntimeSession<T>(
  runtimeId: RuntimeId,
  cwd: string,
  fn: (context: RuntimeSessionContext) => Promise<T>,
): Promise<T> {
  return await withMcpStdio(async (client) => {
    const created = await client.callTool<{ session: { session_id: string } }>(
      "session.create",
      {
        runtime: runtimeId,
        title: `${runtimeId}-utility`,
        cwd,
      },
    );
    const sessionId = created.session.session_id;
    try {
      return await fn({ client, sessionId });
    } finally {
      await client
        .callTool("session.close", { session_id: sessionId })
        .catch(() => undefined);
    }
  });
}

async function execSubmit(
  client: Pick<McpStdioClient, "callTool">,
  sessionId: string,
  code: string,
): Promise<RuntimeSnapshot> {
  const first = await client.callTool<RuntimeSnapshot>("exec", {
    session_id: sessionId,
    code,
    yield_time_ms: 1_000,
  });
  const settled = await waitForSettledExec(client, sessionId, first, {
    timeoutMs: EXEC_SETTLE_TIMEOUT_MS,
  });
  return {
    ...first,
    ...settled,
    session_id: first.session_id,
    stdout_text: settled.stdout_text ?? "",
    stderr_text: settled.stderr_text ?? "",
    result_text: settled.result_text ?? "",
    error_text: settled.error_text ?? "",
    next_seq: settled.next_seq ?? first.next_seq,
    done: settled.done ?? first.done,
  };
}

async function runScenario(
  id: string,
  fn: () => Promise<{
    ok: boolean;
    evidence: Record<string, unknown>;
    notes: string[];
  }>,
): Promise<RuntimeUtilityScenarioResult> {
  const started = performance.now();
  try {
    const result = await fn();
    return {
      id,
      ok: result.ok,
      duration_ms: Math.round(performance.now() - started),
      evidence: result.evidence,
      notes: result.notes,
    };
  } catch (error) {
    return {
      id,
      ok: false,
      duration_ms: Math.round(performance.now() - started),
      evidence: {
        error:
          error instanceof Error ? error.stack || error.message : String(error),
      },
      notes: ["scenario threw before producing structured evidence"],
    };
  }
}
