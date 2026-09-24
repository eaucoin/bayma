import {
  context,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Gauge,
  type Histogram,
  type Span,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { ATTR, METRIC, SCOPE } from "./attributes.ts";
import { settleTelemetryEnvironment } from "./config.ts";
import type { TestResult } from "./junit.ts";
import { LineSplitter } from "./output.ts";
import { developmentResource } from "./resource.ts";

// What development tooling records through. Only OpenTelemetry's API is
// imported here, which records nothing until an SDK is registered; the SDK
// is loaded only when the environment configures it (see config.ts), and
// until then every function here does nothing.

/** How long stopping may take to export what is left before giving up. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

interface Instruments {
  commandDuration: Histogram;
  processDuration: Histogram;
  provisionLookups: Counter;
  downloadSize: Histogram;
  downloadDuration: Histogram;
  artifactSize: Gauge;
  testCases: Counter;
  testDuration: Histogram;
}

interface Session {
  shutdown: () => Promise<void>;
  /** The trace this process continues, from the process that started it. */
  parent: Context;
  instruments: Instruments;
}

let session: Session | undefined;

function createInstruments(): Instruments {
  const meter = metrics.getMeter(SCOPE);
  return {
    commandDuration: meter.createHistogram(METRIC.commandDuration, {
      unit: "s",
      description: "How long a development command took.",
    }),
    processDuration: meter.createHistogram(METRIC.processDuration, {
      unit: "s",
      description: "How long a process development tooling ran took.",
    }),
    provisionLookups: meter.createCounter(METRIC.provisionLookups, {
      description:
        "Provisioned directories looked up, by whether they were reused.",
    }),
    downloadSize: meter.createHistogram(METRIC.downloadSize, {
      unit: "By",
      description: "The size of a pinned download.",
    }),
    downloadDuration: meter.createHistogram(METRIC.downloadDuration, {
      unit: "s",
      description: "How long a pinned download took, verification included.",
    }),
    artifactSize: meter.createGauge(METRIC.artifactSize, {
      unit: "By",
      description: "The size of something a development command produced.",
    }),
    testCases: meter.createCounter(METRIC.testCases, {
      description: "Tests run, by outcome.",
    }),
    testDuration: meter.createHistogram(METRIC.testDuration, {
      unit: "s",
      description: "How long a test that ran took.",
    }),
  };
}

export function telemetryEnabled(): boolean {
  return session !== undefined;
}

/**
 * Starts exporting, when the environment configures it. A process started
 * by one being traced continues its trace, from TRACEPARENT and TRACESTATE.
 */
export async function startTelemetry(): Promise<void> {
  if (session || !settleTelemetryEnvironment(process.env).enabled) return;
  const { startSdk } = await import("./sdk.ts");
  const shutdown = startSdk(developmentResource(process.env));
  session = {
    shutdown,
    parent: propagation.extract(ROOT_CONTEXT, {
      traceparent: process.env.TRACEPARENT,
      tracestate: process.env.TRACESTATE,
    }),
    instruments: createInstruments(),
  };
}

/** Exports what is left and stops. */
export async function stopTelemetry(): Promise<void> {
  const stopping = session;
  session = undefined;
  if (!stopping) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    stopping.shutdown(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The span work is recorded under: the active one, or the process's parent. */
function current(): Context {
  const active = context.active();
  return trace.getSpan(active) || !session ? active : session.parent;
}

function describe(error: unknown): { type: string; message: string } {
  return error instanceof Error
    ? { type: error.name, message: error.message }
    : { type: "Error", message: String(error) };
}

/** Marks `span` as failed by `error`. */
function recordFailure(span: Span, error: unknown): void {
  const { type, message } = describe(error);
  span.recordException(error instanceof Error ? error : message);
  span.setAttribute(ATTR.errorType, type);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Runs `work` in a span named `name`, the child of the current one; a throw
 * marks it failed.
 */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return trace
    .getTracer(SCOPE)
    .startActiveSpan(name, { attributes }, current(), async (span) => {
      try {
        return await work(span);
      } catch (error) {
        recordFailure(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
}

/**
 * Runs a development command in the span every other one it records is
 * under, and records how long it took and how it ended, a failure as an
 * error log too.
 */
export async function inCommand<T>(
  command: string,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let failure: unknown;
  try {
    return await inSpan(command, { [ATTR.command]: command }, async () => {
      try {
        return await work();
      } catch (error) {
        failure = error;
        const { type, message } = describe(error);
        log(
          `${command} failed: ${message}`,
          { [ATTR.command]: command, [ATTR.errorType]: type },
          SeverityNumber.ERROR,
        );
        throw error;
      }
    });
  } finally {
    session?.instruments.commandDuration.record(
      (performance.now() - started) / 1000,
      {
        [ATTR.command]: command,
        ...(failure === undefined
          ? {}
          : { [ATTR.errorType]: describe(failure).type }),
      },
    );
  }
}

/**
 * TRACEPARENT and TRACESTATE for a process started now, so that one that
 * records telemetry continues this trace.
 */
export function traceEnvironment(): Record<string, string> {
  if (!session) return {};
  const carrier: Record<string, string> = {};
  propagation.inject(current(), carrier);
  const environment: Record<string, string> = {};
  if (carrier.traceparent) environment.TRACEPARENT = carrier.traceparent;
  if (carrier.tracestate) environment.TRACESTATE = carrier.tracestate;
  return environment;
}

/** Emits a log record, correlated with the span current in `at`. */
function log(
  body: string,
  attributes: Attributes,
  severity: SeverityNumber,
  at: Context = current(),
): void {
  if (!session) return;
  logs.getLogger(SCOPE).emit({
    body,
    attributes,
    severityNumber: severity,
    severityText: SeverityNumber[severity],
    context: at,
  });
}

/**
 * A process's output, line by line, as log records of the span current now.
 * Nothing when telemetry is off.
 */
export function outputLog(
  iostream: "stdout" | "stderr",
  attributes: Attributes,
): LineSplitter | undefined {
  if (!session) return undefined;
  const at = current();
  return new LineSplitter((line) =>
    log(
      line,
      { ...attributes, [ATTR.logIostream]: iostream },
      SeverityNumber.INFO,
      at,
    ),
  );
}

/** Records how a process ended, on its span and in the process metrics. */
export function recordProcess(
  span: Span,
  executable: string,
  exitCode: number,
  seconds: number,
): void {
  span.setAttribute(ATTR.processExitCode, exitCode);
  if (exitCode !== 0)
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: `exited with status ${exitCode}`,
    });
  session?.instruments.processDuration.record(seconds, {
    [ATTR.processExecutableName]: executable,
    [ATTR.processExitCode]: exitCode,
  });
}

/** Records whether a provisioned directory could be reused. */
export function recordProvisionLookup(directory: string, cached: boolean) {
  session?.instruments.provisionLookups.add(1, {
    [ATTR.provisionDirectory]: directory,
    [ATTR.provisionCached]: cached,
  });
}

/** Records a pinned download, or its reuse from the downloads directory. */
export function recordDownload(
  label: string,
  bytes: number,
  seconds: number,
  cached: boolean,
): void {
  if (!session) return;
  const attributes = {
    [ATTR.downloadLabel]: label,
    [ATTR.downloadCached]: cached,
  };
  session.instruments.downloadSize.record(bytes, attributes);
  session.instruments.downloadDuration.record(seconds, attributes);
}

/** Records the size of something a development command produced. */
export function recordArtifact(artifact: string, bytes: number): void {
  session?.instruments.artifactSize.record(bytes, {
    [ATTR.artifact]: artifact,
  });
}

/**
 * Records a test run's results, from `runner`, as metrics and as one log
 * record per test, correlated with the span current now.
 */
export function recordTests(runner: string, results: TestResult[]): void {
  if (!session) return;
  const { testCases, testDuration } = session.instruments;
  for (const result of results) {
    const attributes: Attributes = {
      [ATTR.testRunner]: runner,
      [ATTR.testSuiteName]: result.suite,
      [ATTR.testCaseResultStatus]: result.status,
    };
    testCases.add(1, attributes);
    if (result.status !== "skipped")
      testDuration.record(result.seconds, attributes);
    log(
      `${result.status} ${result.suite} > ${result.name}` +
        (result.failure?.message ? `: ${result.failure.message}` : ""),
      {
        ...attributes,
        [ATTR.testCaseName]: result.name,
        ...(result.file ? { [ATTR.codeFilePath]: result.file } : {}),
        ...(result.line ? { [ATTR.codeLineNumber]: result.line } : {}),
        ...(result.failure?.type
          ? { [ATTR.errorType]: result.failure.type }
          : {}),
      },
      result.status === "fail" ? SeverityNumber.ERROR : SeverityNumber.INFO,
    );
  }
}
