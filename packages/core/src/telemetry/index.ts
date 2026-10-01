import {
  diag,
  DiagLogLevel,
  propagation,
  ROOT_CONTEXT,
  type Context,
  type DiagLogger,
} from "@opentelemetry/api";
import { settleTelemetryEnvironment } from "./config.ts";

export {
  OTLP_PROTOCOLS,
  settleTelemetryEnvironment,
  SIGNALS,
  type OtlpProtocol,
  type Signal,
  type SignalExport,
  type TelemetryConfig,
} from "./config.ts";

// Starting and stopping telemetry, for bayma's servers and doctor and for its
// development tooling alike. Until it starts, OpenTelemetry's API, which is
// all that records anything, records nothing; it starts only when the
// environment configures it (see config.ts), loading the SDK then.

/** How long stopping may take to export what is left before giving up. */
const SHUTDOWN_TIMEOUT_MS = 30_000;

interface Running {
  shutdown: () => Promise<void>;
  /** The trace this process continues, from the process that started it. */
  parent: Context;
}

let running: Running | undefined;

/** The SDK's own diagnostics, on stderr, at the level OTEL_LOG_LEVEL asks. */
const stderrDiagnostics: DiagLogger = Object.fromEntries(
  (["error", "warn", "info", "debug", "verbose"] as const).map((level) => [
    level,
    (message: string, ...args: unknown[]) =>
      process.stderr.write(
        `bayma: telemetry: ${[message, ...args.map(String)].join(" ")}\n`,
      ),
  ]),
) as unknown as DiagLogger;

/** The level OTEL_LOG_LEVEL names, or undefined for none. */
function diagnosticsLevel(name: string | undefined): DiagLogLevel | undefined {
  const level =
    DiagLogLevel[
      (name ?? "").trim().toUpperCase() as keyof typeof DiagLogLevel
    ];
  return level === undefined || level === DiagLogLevel.NONE ? undefined : level;
}

/**
 * Starts exporting what the environment configures, the process's resource
 * `attributes` beneath what the environment says; a signal configured that
 * bayma cannot export is named on stderr. A process started by one being
 * traced continues its trace, from TRACEPARENT and TRACESTATE.
 */
export async function startTelemetry(
  attributes: Record<string, string>,
): Promise<void> {
  if (running) return;
  const level = diagnosticsLevel(process.env.OTEL_LOG_LEVEL);
  if (level !== undefined)
    diag.setLogger(stderrDiagnostics, { logLevel: level });
  const config = settleTelemetryEnvironment(process.env);
  for (const refusal of config.refusals)
    process.stderr.write(`bayma: telemetry: ${refusal}\n`);
  if (config.exports.length === 0) return;
  const { startSdk } = await import("./sdk.ts");
  running = {
    shutdown: startSdk(config.exports, attributes),
    parent: propagation.extract(ROOT_CONTEXT, {
      traceparent: process.env.TRACEPARENT,
      tracestate: process.env.TRACESTATE,
    }),
  };
}

/**
 * Exports what is left and stops. A backend that cannot take it never fails
 * what recorded it: like the SDK's other troubles, it is told only to
 * OTEL_LOG_LEVEL's diagnostics.
 */
export async function stopTelemetry(): Promise<void> {
  const stopping = running;
  running = undefined;
  if (!stopping) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      stopping.shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    diag.warn(
      `not everything was exported: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Whether telemetry is exporting. */
export function telemetryRunning(): boolean {
  return running !== undefined;
}

/**
 * The trace this process continues: the one the process that started it
 * gave it, or none.
 */
export function processTraceContext(): Context {
  return running?.parent ?? ROOT_CONTEXT;
}
