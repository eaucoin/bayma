import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageManifest } from "../../tooling/src/build.ts";
import { settleTelemetryEnvironment } from "../../tooling/src/telemetry/config.ts";
import { parseJUnit } from "../../tooling/src/telemetry/junit.ts";
import {
  LineSplitter,
  terminalText,
} from "../../tooling/src/telemetry/output.ts";
import { OtlpSink } from "../support/otlp-sink.ts";
import { ARTIFACT, COMMAND } from "../support/telemetry-command.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const commandScript = join(
  repoRoot,
  "tests",
  "support",
  "telemetry-command.ts",
);
const COMMAND_TIMEOUT_MS = 60_000;

describe("configuration", () => {
  test("nothing is exported until something is configured", () => {
    const env = { PATH: "/bin" };
    expect(settleTelemetryEnvironment(env)).toEqual({
      enabled: false,
      signals: [],
    });
    expect(env).toEqual({ PATH: "/bin" });
  });

  test("a variable set to nothing is unset", () => {
    const env: Record<string, string | undefined> = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_HEADERS: " ",
    };
    expect(settleTelemetryEnvironment(env).enabled).toBe(false);
    expect(env).toEqual({});
  });

  test("an endpoint for every signal exports every signal", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
    expect(settleTelemetryEnvironment(env)).toEqual({
      enabled: true,
      signals: ["traces", "metrics", "logs"],
    });
  });

  test("an endpoint or exporter for one signal exports that signal alone", () => {
    const env: Record<string, string | undefined> = {
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://collector:4318/v1/logs",
      OTEL_TRACES_EXPORTER: "console",
    };
    expect(settleTelemetryEnvironment(env).signals).toEqual(["traces", "logs"]);
    expect(env.OTEL_METRICS_EXPORTER).toBe("none");
  });

  test("an exporter of none turns its signal off", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_METRICS_EXPORTER: "none",
    };
    expect(settleTelemetryEnvironment(env).signals).toEqual(["traces", "logs"]);
  });

  test("OTEL_SDK_DISABLED turns everything off", () => {
    const env = {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_SDK_DISABLED: "true",
    };
    expect(settleTelemetryEnvironment(env).enabled).toBe(false);
  });
});

describe("process output", () => {
  test("is the lines a terminal shows", () => {
    expect(terminalText("\u001b[32mpassed\u001b[0m")).toBe("passed");
    expect(terminalText("10%\r50%\r100%")).toBe("100%");
    expect(terminalText("windows line\r")).toBe("windows line");
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.write("first li");
    splitter.write("ne\n\n   \nsecond\r\nthi");
    splitter.write("rd");
    expect(lines).toEqual(["first line", "second"]);
    splitter.end();
    expect(lines).toEqual(["first line", "second", "third"]);
  });
});

describe("JUnit reports", () => {
  test("from bun test give each test, within its describe blocks", () => {
    const results = parseJUnit(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" failures="1" skipped="1">
  <testsuite name="sample.test.ts" file="sample.test.ts" tests="4">
    <testsuite name="group" file="sample.test.ts" line="2" tests="2">
      <testcase name="passes" classname="group" time="0.030645" file="sample.test.ts" line="2" />
      <testcase name="fails" classname="group" time="0.000662" file="sample.test.ts" line="3">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="later" classname="" time="0" file="sample.test.ts" line="5">
      <skipped message="TODO" />
    </testcase>
    <testcase name="top" classname="" time="0.000038" file="sample.test.ts" line="6" />
  </testsuite>
</testsuites>`);
    expect(results).toEqual([
      {
        suite: "sample.test.ts",
        name: "later",
        status: "skipped",
        seconds: 0,
        file: "sample.test.ts",
        line: 5,
      },
      {
        suite: "sample.test.ts",
        name: "top",
        status: "pass",
        seconds: 0.000038,
        file: "sample.test.ts",
        line: 6,
      },
      {
        suite: "sample.test.ts",
        name: "group > passes",
        status: "pass",
        seconds: 0.030645,
        file: "sample.test.ts",
        line: 2,
      },
      {
        suite: "sample.test.ts",
        name: "group > fails",
        status: "fail",
        seconds: 0.000662,
        file: "sample.test.ts",
        line: 3,
        failure: { type: "AssertionError", message: undefined },
      },
    ]);
  });

  test("from pytest give each test, by its class, with why it failed", () => {
    const results = parseJUnit(`<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="pytest" errors="1" failures="1" skipped="1" tests="4">
    <testcase classname="tests.test_things.ThingTest" name="test_works" time="0.001" />
    <testcase classname="tests.test_things.ThingTest" name="test_breaks" time="0.002">
      <failure message="AssertionError: 1 != 2">Traceback (most recent call last)</failure>
    </testcase>
    <testcase classname="tests.test_things" name="test_setup" time="0.003">
      <error message="failed on setup">Traceback</error>
    </testcase>
    <testcase classname="tests.test_things" name="test_later" time="0">
      <skipped type="pytest.skip" message="not yet">skipped</skipped>
    </testcase>
  </testsuite>
</testsuites>`);
    expect(
      results.map(({ suite, name, status, failure }) => ({
        suite,
        name,
        status,
        message: failure?.message,
      })),
    ).toEqual([
      {
        suite: "tests.test_things.ThingTest",
        name: "test_works",
        status: "pass",
        message: undefined,
      },
      {
        suite: "tests.test_things.ThingTest",
        name: "test_breaks",
        status: "fail",
        message: "AssertionError: 1 != 2",
      },
      {
        suite: "tests.test_things",
        name: "test_setup",
        status: "fail",
        message: "failed on setup",
      },
      {
        suite: "tests.test_things",
        name: "test_later",
        status: "skipped",
        message: undefined,
      },
    ]);
  });
});

/**
 * This process's environment without telemetry's, which a developer running
 * these tests with telemetry on would otherwise pass to the command.
 */
function untracedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("OTEL_") &&
        !["TRACEPARENT", "TRACESTATE"].includes(entry[0]),
    ),
  );
}

async function runCommand(
  mode: "succeed" | "fail",
  env: Record<string, string>,
): Promise<number> {
  const child = Bun.spawn(
    ["bun", commandScript, mode, ...(mode === "succeed" ? [testsDir] : [])],
    {
      cwd: repoRoot,
      env: { ...untracedEnvironment(), ...env },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return child.exited;
}

/** Where the command's own tests are: one passes, one fails, one is skipped. */
let testsDir: string;

beforeAll(() => {
  testsDir = mkdtempSync(join(tmpdir(), "bayma-telemetry-tests-"));
  writeFileSync(
    join(testsDir, "sample.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'test("passes", () => expect(1).toBe(1));',
      'test("fails", () => expect(1).toBe(2));',
      'test.skip("skipped", () => {});',
    ].join("\n"),
  );
});

afterAll(() => rmSync(testsDir, { recursive: true, force: true }));

describe("a development command", () => {
  let sink: OtlpSink;

  beforeAll(() => {
    sink = new OtlpSink();
  });

  afterAll(() => sink.stop());

  const exported = (env: Record<string, string> = {}) => ({
    OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    ...env,
  });

  test(
    "exports its processes, their output, its tests, and its metrics",
    async () => {
      expect(await runCommand("succeed", exported())).toBe(0);
      const { spans, logs, metrics } = sink;

      const root = spans.find((span) => span.name === COMMAND)!;
      expect(root.attributes["bayma.dev.command"]).toBe(COMMAND);
      expect(root.parentSpanId).toBe("");
      expect(root.resource["service.name"]).toBe("bayma-development");
      expect(root.resource["service.version"]).toBe(
        packageManifest(repoRoot).version,
      );
      expect(root.resource["vcs.ref.head.revision"]).toBe(
        spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
          .stdout.toString()
          .trim(),
      );

      const processes = spans.filter(
        (span) =>
          span.traceId === root.traceId &&
          span.attributes["process.executable.name"] === "bun",
      );
      expect(
        processes.map((span) => span.attributes["process.exit.code"]),
      ).toEqual([0, 3, 1]);
      const [writer, failed, tests] = processes;
      expect(writer!.parentSpanId).toBe(root.spanId);
      expect(writer!.statusCode).toBe(0);
      expect(writer!.attributes["process.command_args"]).toContain("-e");
      expect(failed!.statusCode).toBe(2);
      const testSpan = spans.find((span) => span.name === "test bun")!;
      expect(testSpan.parentSpanId).toBe(root.spanId);
      expect(tests!.parentSpanId).toBe(testSpan.spanId);

      // Each line of output is a log of its process's span, and the process
      // was told the trace, so what it records would continue it.
      const line = (body: string) => logs.find((log) => log.body === body)!;
      for (const [body, iostream] of [
        ["to stdout", "stdout"],
        ["to stderr", "stderr"],
      ] as const) {
        expect(line(body).attributes["log.iostream"]).toBe(iostream);
        expect(line(body).spanId).toBe(writer!.spanId);
        expect(line(body).traceId).toBe(root.traceId);
      }
      expect(
        logs.some(
          (log) =>
            log.body ===
            `traceparent 00-${writer!.traceId}-${writer!.spanId}-01`,
        ),
      ).toBe(true);

      // Each test is a log of the test run's span, by outcome.
      const results = logs.filter(
        (log) => log.attributes["bayma.dev.test.runner"] === "bun",
      );
      expect(
        results
          .map((log) => [
            log.attributes["test.case.name"],
            log.attributes["test.case.result.status"],
            log.severityNumber,
          ])
          .sort(),
      ).toEqual([
        ["fails", "fail", 17],
        ["passes", "pass", 9],
        ["skipped", "skipped", 9],
      ]);
      expect(results.every((log) => log.spanId === testSpan.spanId)).toBe(true);

      const names = new Set(metrics.map((metric) => metric.name));
      for (const name of [
        "bayma.dev.command.duration",
        "bayma.dev.process.duration",
        "bayma.dev.test.cases",
        "bayma.dev.test.duration",
        "bayma.dev.artifact.size",
      ])
        expect(names).toContain(name);
      expect(
        metrics
          .filter((metric) => metric.name === "bayma.dev.artifact.size")
          .flatMap((metric) => metric.points)
          .map((point) => point["bayma.dev.artifact"]),
      ).toContain(ARTIFACT);
    },
    COMMAND_TIMEOUT_MS,
  );

  test(
    "that fails still exports, marked failed",
    async () => {
      const before = { spans: sink.spans.length, logs: sink.logs.length };
      expect(await runCommand("fail", exported())).toBe(1);
      const spans = sink.spans.slice(before.spans);
      const root = spans.find((span) => span.name === COMMAND)!;
      expect(root.statusCode).toBe(2);
      expect(root.attributes["error.type"]).toBe("Error");
      const child = spans.find(
        (span) => span.attributes["process.exit.code"] === 4,
      )!;
      expect(child.statusCode).toBe(2);
      expect(child.parentSpanId).toBe(root.spanId);
      const failure = sink.logs
        .slice(before.logs)
        .find((log) => log.severityNumber === 17)!;
      expect(failure.body).toStartWith(`${COMMAND} failed: `);
      expect(failure.spanId).toBe(root.spanId);
    },
    COMMAND_TIMEOUT_MS,
  );

  test(
    "continues the trace it was started in, as the service it is told it is",
    async () => {
      const before = sink.spans.length;
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentId = "00f067aa0ba902b7";
      expect(
        await runCommand(
          "fail",
          exported({
            TRACEPARENT: `00-${traceId}-${parentId}-01`,
            OTEL_SERVICE_NAME: "someone's-service",
          }),
        ),
      ).toBe(1);
      const root = sink.spans
        .slice(before)
        .find((span) => span.name === COMMAND)!;
      expect(root.traceId).toBe(traceId);
      expect(root.parentSpanId).toBe(parentId);
      expect(root.resource["service.name"]).toBe("someone's-service");
    },
    COMMAND_TIMEOUT_MS,
  );
});

describe("a development command configured for one signal", () => {
  test(
    "exports that signal alone",
    async () => {
      const sink = new OtlpSink();
      try {
        expect(
          await runCommand("fail", {
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${sink.url}/v1/logs`,
            OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
          }),
        ).toBe(1);
        expect(sink.paths.length).toBeGreaterThan(0);
        expect(new Set(sink.paths)).toEqual(new Set(["/v1/logs"]));
      } finally {
        sink.stop();
      }
    },
    COMMAND_TIMEOUT_MS,
  );
});

describe("a development command with OTEL_SDK_DISABLED", () => {
  test(
    "exports nothing, though configured",
    async () => {
      const sink = new OtlpSink();
      try {
        expect(
          await runCommand("fail", {
            OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
            OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
            OTEL_SDK_DISABLED: "true",
          }),
        ).toBe(1);
        expect(sink.paths).toEqual([]);
      } finally {
        sink.stop();
      }
    },
    COMMAND_TIMEOUT_MS,
  );
});
