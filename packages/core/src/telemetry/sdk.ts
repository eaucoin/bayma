import { context, propagation, trace, metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  getNumberFromEnv,
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
import type { SignalExport } from "./config.ts";

// The OpenTelemetry SDK, which only telemetry that is configured loads,
// assembled from its parts rather than OpenTelemetry's Node SDK so that what
// bayma ships carries only what exports over OTLP's HTTP protocols. Each
// exporter reads its endpoint, headers, compression, and timeout, and each
// processor and reader its own settings, from OpenTelemetry's environment
// variables; see config.ts.

/**
 * Starts the SDK for `exports`, with `attributes` as the resource beneath
 * what the environment and the host and process detectors say. Returns what
 * flushes and stops it.
 */
export function startSdk(
  exports: readonly SignalExport[],
  attributes: Record<string, string>,
): () => Promise<void> {
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
            ? new JsonTraceExporter()
            : new ProtobufTraceExporter(),
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
            ? new JsonMetricExporter()
            : new ProtobufMetricExporter(),
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
            ? new JsonLogExporter()
            : new ProtobufLogExporter(),
        }),
      ],
    });
    logs.setGlobalLoggerProvider(loggerProvider);
    stops.push(() => loggerProvider.shutdown());
  }
  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}
