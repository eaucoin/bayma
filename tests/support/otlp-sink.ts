// An OTLP/HTTP receiver for tests: it accepts what an OpenTelemetry SDK
// exports as http/json and keeps it, decoded, for assertions.

type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
};

type KeyValue = { key: string; value: AnyValue };

export type Attributes = Record<string, unknown>;

export interface ReceivedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  /** 0 unset, 1 ok, 2 error. */
  statusCode: number;
  attributes: Attributes;
  resource: Attributes;
}

export interface ReceivedLog {
  body: string;
  severityNumber: number;
  traceId: string;
  spanId: string;
  attributes: Attributes;
}

export interface ReceivedMetric {
  name: string;
  points: Attributes[];
}

function decode(value: AnyValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decode);
  return undefined;
}

function attributes(list: KeyValue[] | undefined): Attributes {
  return Object.fromEntries(
    (list ?? []).map(({ key, value }) => [key, decode(value)]),
  );
}

interface Payload {
  resourceSpans?: {
    resource?: { attributes?: KeyValue[] };
    scopeSpans?: {
      spans?: {
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        status?: { code?: number };
        attributes?: KeyValue[];
      }[];
    }[];
  }[];
  resourceLogs?: {
    scopeLogs?: {
      logRecords?: {
        body?: AnyValue;
        severityNumber?: number;
        traceId?: string;
        spanId?: string;
        attributes?: KeyValue[];
      }[];
    }[];
  }[];
  resourceMetrics?: {
    scopeMetrics?: {
      metrics?: ({ name: string } & Partial<
        Record<MetricKind, { dataPoints?: { attributes?: KeyValue[] }[] }>
      >)[];
    }[];
  }[];
}

/** OTLP's kinds of metric data, one of which a metric carries. */
const METRIC_KINDS = [
  "gauge",
  "sum",
  "histogram",
  "exponentialHistogram",
  "summary",
] as const;
type MetricKind = (typeof METRIC_KINDS)[number];

export class OtlpSink {
  readonly spans: ReceivedSpan[] = [];
  readonly logs: ReceivedLog[] = [];
  readonly metrics: ReceivedMetric[] = [];
  /** Every path requested, in order. */
  readonly paths: string[] = [];
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        this.paths.push(path);
        this.receive((await request.json()) as Payload);
        return Response.json({});
      },
    });
  }

  /** The endpoint to give OTEL_EXPORTER_OTLP_ENDPOINT. */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    void this.server.stop(true);
  }

  private receive(payload: Payload): void {
    for (const resourceSpans of payload.resourceSpans ?? []) {
      const resource = attributes(resourceSpans.resource?.attributes);
      for (const scope of resourceSpans.scopeSpans ?? [])
        for (const span of scope.spans ?? [])
          this.spans.push({
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId ?? "",
            statusCode: span.status?.code ?? 0,
            attributes: attributes(span.attributes),
            resource,
          });
    }
    for (const resourceLogs of payload.resourceLogs ?? [])
      for (const scope of resourceLogs.scopeLogs ?? [])
        for (const record of scope.logRecords ?? [])
          this.logs.push({
            body: String(record.body ? decode(record.body) : ""),
            severityNumber: record.severityNumber ?? 0,
            traceId: record.traceId ?? "",
            spanId: record.spanId ?? "",
            attributes: attributes(record.attributes),
          });
    for (const resourceMetrics of payload.resourceMetrics ?? [])
      for (const scope of resourceMetrics.scopeMetrics ?? [])
        for (const metric of scope.metrics ?? []) {
          const kind = METRIC_KINDS.find((name) => metric[name]);
          this.metrics.push({
            name: metric.name,
            points: (kind ? (metric[kind]?.dataPoints ?? []) : []).map(
              (point) => attributes(point.attributes),
            ),
          });
        }
  }
}
