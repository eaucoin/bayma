import {
  context,
  INVALID_SPAN_CONTEXT,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Link,
  type MetricOptions,
  type ObservableGauge,
  type ObservableResult,
  type Span,
} from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { BAYMA_VERSION } from "../version.ts";
import { processTraceContext } from "./index.ts";

// What bayma's servers and doctor record their work through: spans, metrics,
// and log records under the instrumentation scope `bayma`. Only
// OpenTelemetry's API is used here, which records nothing until telemetry
// starts (see index.ts).

const SCOPE = "bayma";

const tracer = trace.getTracer(SCOPE, BAYMA_VERSION);

export { SeverityNumber, SpanKind };

/** What a failure records: its type, its message, and an error status. */
export function markFailed(span: Span, failure: unknown): void {
  const message = failure instanceof Error ? failure.message : String(failure);
  if (failure instanceof Error) span.recordException(failure);
  span.setAttribute(
    "error.type",
    failure instanceof Error ? failure.name : "Error",
  );
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Where a span begins unless told otherwise: in the active span, or else in
 * the trace this process continues, if any.
 */
function current(): Context {
  const active = context.active();
  return trace.getSpan(active) ? active : processTraceContext();
}

export interface SpanOptions {
  kind?: SpanKind;
  links?: Link[];
  /** The context the span is a child of, if not the current one. */
  parent?: Context;
}

/**
 * Runs `work` in a span named `name`, and ends it when `work` settles; a
 * throw marks it failed.
 */
export async function inSpan<T>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<T>,
  { kind, links, parent = current() }: SpanOptions = {},
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { attributes, kind, links },
    parent,
    async (span) => {
      try {
        return await work(span);
      } catch (error) {
        markFailed(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Starts a span, in `parent`, that ends when its caller ends it. */
export function startSpan(
  name: string,
  attributes: Attributes,
  parent: Context = current(),
  kind: SpanKind = SpanKind.INTERNAL,
): Span {
  return tracer.startSpan(name, { attributes, kind }, parent);
}

/** The span active now, which records nothing when none is. */
export function activeSpan(): Span {
  return trace.getActiveSpan() ?? trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
}

// The metrics API, unlike the trace and logs APIs, hands out a meter that
// records nothing forever when asked before telemetry starts, and modules
// declare their instruments as they load. So an instrument is made from the
// meter provider current when it first records, and again if that changes.
function lazily<T>(make: () => T): () => T {
  let made: T | undefined;
  let provider: unknown;
  return () => {
    const current = metrics.getMeterProvider();
    if (made === undefined || provider !== current) {
      provider = current;
      made = make();
    }
    return made;
  };
}

function meter() {
  return metrics.getMeter(SCOPE, BAYMA_VERSION);
}

/** A histogram, recorded under `name`. */
export function histogram(
  name: string,
  options: MetricOptions,
): Pick<Histogram, "record"> {
  const instrument = lazily(() => meter().createHistogram(name, options));
  return {
    record: (value, attributes) => instrument().record(value, attributes),
  };
}

/** A counter, recorded under `name`. */
export function counter(
  name: string,
  options: MetricOptions,
): Pick<Counter, "add"> {
  const instrument = lazily(() => meter().createCounter(name, options));
  return { add: (value, attributes) => instrument().add(value, attributes) };
}

/**
 * A gauge whose value `observe` reports whenever metrics are read. Returns
 * what stops it.
 */
export function observeGauge(
  name: string,
  options: MetricOptions,
  observe: (result: ObservableResult) => void,
): () => void {
  const gauge: ObservableGauge = meter().createObservableGauge(name, options);
  gauge.addCallback(observe);
  return () => gauge.removeCallback(observe);
}

/** A log record, of the span active now; `eventName` makes it an event's. */
export function log(
  severity: SeverityNumber,
  body: string,
  attributes: Attributes = {},
  eventName?: string,
): void {
  logs.getLogger(SCOPE, BAYMA_VERSION).emit({
    severityNumber: severity,
    severityText: SeverityNumber[severity],
    body,
    attributes,
    ...(eventName ? { eventName } : {}),
  });
}

/**
 * Tells the server's operator `line` on stderr, as bayma always has, and
 * records it as a log record too.
 */
export function report(
  line: string,
  attributes: Attributes = {},
  severity: SeverityNumber = SeverityNumber.WARN,
): void {
  process.stderr.write(`${line}\n`);
  log(severity, line, attributes);
}
