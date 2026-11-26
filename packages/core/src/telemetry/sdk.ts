import { readFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { resolve } from "node:path";
import { context, diag, propagation, trace, metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  getNumberFromEnv,
  getStringFromEnv,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPLogExporter as JsonLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as ProtobufLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as JsonMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as ProtobufMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as JsonTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtobufTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { readTokenFile } from "../token-file.ts";
import type { SignalExport } from "./config.ts";
import type { Sdk } from "./index.ts";

// The OpenTelemetry SDK, which only telemetry that is configured loads,
// assembled from its parts rather than OpenTelemetry's Node SDK so that what
// bayma ships carries only what exports over OTLP's HTTP protocols. Each
// exporter reads its endpoint, headers, compression, and timeout, and each
// processor and reader its own settings, from OpenTelemetry's environment
// variables; see config.ts. Only the exporters' HTTP agents are bayma's own,
// made as the SDK would make them, so that a restored sandbox can end the
// connections they keep (exportAgents).

/**
 * The headers of an export carrying the token `file` holds as its bearer,
 * read for each export. An export whose token cannot be read fails, which is
 * said on stderr, once until a token is read again.
 */
function bearerHeaders(file: string): () => Promise<Record<string, string>> {
  let failing = false;
  return async () => {
    try {
      const token = readTokenFile(file, "the telemetry bearer token");
      failing = false;
      return { authorization: `Bearer ${token}` };
    } catch (error) {
      if (!failing)
        process.stderr.write(
          `bayma: telemetry: not exported: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      failing = true;
      throw error;
    }
  };
}

/**
 * The file a TLS variable of `signal`'s names, as the SDK reads it: the
 * signal's own variable, or else the one for every signal, relative to the
 * working directory. One that cannot be read is said to the SDK's
 * diagnostics, as `unread`, and left out.
 */
function tlsFile(
  signal: SignalExport["signal"],
  variable: "CERTIFICATE" | "CLIENT_CERTIFICATE" | "CLIENT_KEY",
  unread: string,
): Buffer | undefined {
  const file =
    getStringFromEnv(
      `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${variable}`,
    ) ?? getStringFromEnv(`OTEL_EXPORTER_OTLP_${variable}`);
  if (file === undefined) return undefined;
  try {
    return readFileSync(resolve(process.cwd(), file));
  } catch {
    diag.warn(unread);
    return undefined;
  }
}

/** Exports' HTTP agents, which can end every connection they keep. */
interface Agents {
  /**
   * What makes the agent `signal`'s exporter sends with, as the SDK would
   * make it: keeping its connections alive and, over HTTPS, presenting the
   * TLS files the variables name, read as the exporter is made, from the
   * environment the server started with.
   */
  of: (
    signal: SignalExport["signal"],
  ) => (protocol: string) => HttpAgent | HttpsAgent;
  /** Ends every connection each agent made keeps. */
  end: () => void;
}

function exportAgents(): Agents {
  const made: (HttpAgent | HttpsAgent)[] = [];
  return {
    of: (signal) => {
      const tls = {
        ca: tlsFile(
          signal,
          "CERTIFICATE",
          "Failed to read root certificate file",
        ),
        cert: tlsFile(
          signal,
          "CLIENT_CERTIFICATE",
          "Failed to read client certificate chain file",
        ),
        key: tlsFile(
          signal,
          "CLIENT_KEY",
          "Failed to read client certificate private key file",
        ),
      };
      return (protocol) => {
        const agent =
          protocol === "http:"
            ? new HttpAgent({ keepAlive: true })
            : new HttpsAgent({ keepAlive: true, ...tls });
        made.push(agent);
        return agent;
      };
    },
    end: () => {
      for (const agent of made) agent.destroy();
    },
  };
}

/**
 * Starts the SDK for `exports`, with `attributes` as the resource beneath
 * what the environment and the host and process detectors say, and with the
 * token `bearerTokenFile` holds, when given, as every export's bearer, read
 * for each export.
 */
export function startSdk(
  exports: readonly SignalExport[],
  attributes: Record<string, string>,
  bearerTokenFile?: string,
): Sdk {
  // The agents the SDK makes cannot be told to end their connections: bayma
  // makes each exporter's itself, as the SDK would.
  const agents = exportAgents();
  const bearer =
    bearerTokenFile === undefined
      ? {}
      : { headers: bearerHeaders(bearerTokenFile) };
  const exporterOptions = (signal: SignalExport["signal"]) => ({
    ...bearer,
    httpAgentOptions: agents.of(signal),
  });
  const resource = defaultResource()
    .merge(resourceFromAttributes(attributes))
    .merge(
      detectResources({
        detectors: [hostDetector, processDetector, envDetector],
      }),
    );
  const json = (signal: SignalExport["signal"]) =>
    exports.find((exported) => exported.signal === signal)?.protocol ===
    "http/json";
  const exported = new Set(exports.map(({ signal }) => signal));
  const stops: (() => Promise<void>)[] = [];

  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  );
  if (exported.has("traces")) {
    const tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(
          json("traces")
            ? new JsonTraceExporter(exporterOptions("traces"))
            : new ProtobufTraceExporter(exporterOptions("traces")),
        ),
      ],
    });
    trace.setGlobalTracerProvider(tracerProvider);
    stops.push(() => tracerProvider.shutdown());
  }
  if (exported.has("metrics")) {
    const exportIntervalMillis =
      getNumberFromEnv("OTEL_METRIC_EXPORT_INTERVAL") ?? 60_000;
    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: json("metrics")
            ? new JsonMetricExporter(exporterOptions("metrics"))
            : new ProtobufMetricExporter(exporterOptions("metrics")),
          exportIntervalMillis,
          // An export may take no longer than the interval between two, as
          // the reader requires: the timeout is clamped to the interval.
          exportTimeoutMillis: Math.min(
            getNumberFromEnv("OTEL_METRIC_EXPORT_TIMEOUT") ?? 30_000,
            exportIntervalMillis,
          ),
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);
    stops.push(() => meterProvider.shutdown());
  }
  if (exported.has("logs")) {
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: json("logs")
            ? new JsonLogExporter(exporterOptions("logs"))
            : new ProtobufLogExporter(exporterOptions("logs")),
        }),
      ],
    });
    logs.setGlobalLoggerProvider(loggerProvider);
    stops.push(() => loggerProvider.shutdown());
  }
  return {
    shutdown: async () => {
      await Promise.all(stops.map((stop) => stop()));
    },
    reconnect: agents.end,
  };
}
