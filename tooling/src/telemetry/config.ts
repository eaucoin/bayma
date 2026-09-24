// Development telemetry: the traces, metrics, and logs of bayma's own
// development — its scripts, provisioning, builds, and test runs, locally and
// in CI — exported with OpenTelemetry to whatever backend a developer chooses.
// The packages bayma publishes carry none of it.
//
// It is configured only through OpenTelemetry's standard environment
// variables, which the OpenTelemetry SDK reads:
// https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
// and https://opentelemetry.io/docs/specs/otel/protocol/exporter/
//
//   OTEL_EXPORTER_OTLP_ENDPOINT          where to send every signal over OTLP
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   ...or each signal separately
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
//   OTEL_EXPORTER_OTLP_PROTOCOL          grpc, http/protobuf, or http/json,
//                                        and OTEL_EXPORTER_OTLP_*_PROTOCOL
//   OTEL_EXPORTER_OTLP_HEADERS           authentication, and the per-signal
//                                        OTEL_EXPORTER_OTLP_*_HEADERS
//   OTEL_TRACES_EXPORTER                 otlp, console, or none; likewise
//   OTEL_METRICS_EXPORTER                OTEL_METRICS_EXPORTER and
//   OTEL_LOGS_EXPORTER                   OTEL_LOGS_EXPORTER
//   OTEL_SERVICE_NAME                    bayma-development unless set
//   OTEL_RESOURCE_ATTRIBUTES             more attributes for every signal
//   OTEL_METRIC_EXPORT_INTERVAL          and the SDK's other variables
//   OTEL_SDK_DISABLED=true               turns it all off
//
// and the rest of OpenTelemetry's exporter and SDK variables, all as the
// specification describes, with two differences that keep an unconfigured
// checkout quiet. Nothing is exported, and the SDK is not even loaded, until a
// variable names somewhere to export to. And each signal is exported only
// when an endpoint or an exporter is set for it, or for every signal: an
// endpoint for logs alone exports logs alone. A variable set to the empty
// string counts as unset, as CI sets one whose secret is missing.

export const SIGNALS = ["traces", "metrics", "logs"] as const;
export type Signal = (typeof SIGNALS)[number];

type Environment = Record<string, string | undefined>;

function isSet(env: Environment, name: string): boolean {
  return (env[name] ?? "").trim() !== "";
}

/** Whether `signal` has somewhere to go. */
function configured(env: Environment, signal: Signal): boolean {
  const upper = signal.toUpperCase();
  const exporter = (env[`OTEL_${upper}_EXPORTER`] ?? "").trim();
  if (exporter !== "") return exporter !== "none";
  return (
    isSet(env, "OTEL_EXPORTER_OTLP_ENDPOINT") ||
    isSet(env, `OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`)
  );
}

export interface TelemetryConfig {
  /** Whether any signal is exported. */
  enabled: boolean;
  /** The signals exported. */
  signals: Signal[];
}

/**
 * Reads the configuration from `env`, and settles it there for the SDK and
 * for every process this one starts: empty variables are removed, and a
 * signal with nowhere to go is set to the `none` exporter.
 */
export function settleTelemetryEnvironment(env: Environment): TelemetryConfig {
  for (const name of Object.keys(env))
    if (name.startsWith("OTEL_") && !isSet(env, name)) delete env[name];
  if ((env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true")
    return { enabled: false, signals: [] };
  const signals = SIGNALS.filter((signal) => configured(env, signal));
  if (signals.length > 0)
    for (const signal of SIGNALS)
      if (!signals.includes(signal))
        env[`OTEL_${signal.toUpperCase()}_EXPORTER`] = "none";
  return { enabled: signals.length > 0, signals };
}
