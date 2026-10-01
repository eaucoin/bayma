// bayma's telemetry: the traces, metrics, and logs of bayma itself, its
// servers and doctor, and of its development, its scripts, provisioning,
// builds, and test runs, locally and in CI, exported with OpenTelemetry to
// whatever backend its operator or developer chooses.
//
// It is configured only through OpenTelemetry's standard environment
// variables: https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
// and https://opentelemetry.io/docs/specs/otel/protocol/exporter/
//
//   OTEL_EXPORTER_OTLP_ENDPOINT          where to send every signal over OTLP
//   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   ...or each signal separately
//   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
//   OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
//   OTEL_EXPORTER_OTLP_PROTOCOL          http/protobuf, the default, or
//                                        http/json, and the per-signal
//                                        OTEL_EXPORTER_OTLP_*_PROTOCOL
//   OTEL_EXPORTER_OTLP_HEADERS           authentication, and the per-signal
//                                        OTEL_EXPORTER_OTLP_*_HEADERS
//   OTEL_TRACES_EXPORTER                 each signal's exporter: otlp or none
//   OTEL_METRICS_EXPORTER
//   OTEL_LOGS_EXPORTER
//   OTEL_SERVICE_NAME                    bayma, or bayma-development, unless set
//   OTEL_RESOURCE_ATTRIBUTES             more attributes for every signal
//   OTEL_METRIC_EXPORT_INTERVAL          and the SDK's other variables
//   OTEL_LOG_LEVEL                       the SDK's own diagnostics, on stderr
//   OTEL_SDK_DISABLED=true               turns it all off
//
// All are as the specification describes, with three differences. Nothing is
// exported, and the SDK is not even loaded, until a variable names somewhere
// to export to. Each signal is exported only when an endpoint or an exporter
// is set for it, or for every signal: an endpoint for logs alone exports logs
// alone. And bayma exports over OTLP's HTTP protocols alone: a server serving
// MCP over stdio owns stdout, where the console exporters would write, and
// OTLP over gRPC would bring a gRPC client into what bayma ships. A variable set to
// the empty string counts as unset, as otel.env.example's are and as CI sets
// one whose secret is missing.

export const SIGNALS = ["traces", "metrics", "logs"] as const;
export type Signal = (typeof SIGNALS)[number];

export const OTLP_PROTOCOLS = ["http/protobuf", "http/json"] as const;
export type OtlpProtocol = (typeof OTLP_PROTOCOLS)[number];

type Environment = Record<string, string | undefined>;

function setting(env: Environment, name: string): string {
  return (env[name] ?? "").trim();
}

/** Whether `signal` has somewhere to go. */
function configured(env: Environment, signal: Signal): boolean {
  const upper = signal.toUpperCase();
  const exporter = setting(env, `OTEL_${upper}_EXPORTER`);
  if (exporter !== "") return exporter !== "none";
  return (
    setting(env, "OTEL_EXPORTER_OTLP_ENDPOINT") !== "" ||
    setting(env, `OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`) !== ""
  );
}

/** The OTLP protocol `signal` goes over, or why bayma cannot export it. */
function protocol(
  env: Environment,
  signal: Signal,
): { protocol: OtlpProtocol } | { refusal: string } {
  const upper = signal.toUpperCase();
  const exporter = setting(env, `OTEL_${upper}_EXPORTER`) || "otlp";
  if (exporter !== "otlp")
    return { refusal: `${signal}: bayma has no ${exporter} exporter` };
  const chosen =
    setting(env, `OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`) ||
    setting(env, "OTEL_EXPORTER_OTLP_PROTOCOL") ||
    "http/protobuf";
  return (OTLP_PROTOCOLS as readonly string[]).includes(chosen)
    ? { protocol: chosen as OtlpProtocol }
    : {
        refusal: `${signal}: bayma exports over ${OTLP_PROTOCOLS.join(" or ")}, not ${chosen}`,
      };
}

export interface SignalExport {
  signal: Signal;
  protocol: OtlpProtocol;
}

export interface TelemetryConfig {
  /** The signals exported, and over which protocol each goes. */
  exports: SignalExport[];
  /** Why each signal configured that bayma cannot export is not exported. */
  refusals: string[];
}

/**
 * Reads the configuration from `env`, and settles it there for the SDK and
 * for every process this one starts: empty variables are removed, and a
 * signal with nowhere to go, or that bayma cannot export, is set to the
 * `none` exporter.
 */
export function settleTelemetryEnvironment(env: Environment): TelemetryConfig {
  for (const name of Object.keys(env))
    if (name.startsWith("OTEL_") && setting(env, name) === "") delete env[name];
  if (setting(env, "OTEL_SDK_DISABLED").toLowerCase() === "true")
    return { exports: [], refusals: [] };
  const exports: SignalExport[] = [];
  const refusals: string[] = [];
  for (const signal of SIGNALS.filter((signal) => configured(env, signal))) {
    const chosen = protocol(env, signal);
    if ("protocol" in chosen)
      exports.push({ signal, protocol: chosen.protocol });
    else refusals.push(chosen.refusal);
  }
  if (exports.length > 0 || refusals.length > 0)
    for (const signal of SIGNALS)
      if (!exports.some((exported) => exported.signal === signal))
        env[`OTEL_${signal.toUpperCase()}_EXPORTER`] = "none";
  return { exports, refusals };
}
