import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";
import {
  BAGGAGE_META_KEY,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type MessageExtraInfo,
  type Transport,
} from "@modelcontextprotocol/server";
import { histogram, startSpan } from "../telemetry/record.ts";

// MCP's telemetry, as OpenTelemetry's semantic conventions for MCP describe
// it: a server span for each request a client sends, and how long each took.
// https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md
//
// A request continues the trace its client propagated: in its params' _meta,
// as the specification has it (SEP-414), or else, over HTTP, in a
// `traceparent` header. One that carries neither starts a trace of its own.

/** Seconds, as the conventions advise for MCP's durations. */
const MCP_SECONDS = [
  0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300,
];

const operationDuration = histogram("mcp.server.operation.duration", {
  unit: "s",
  description: "How long bayma took to answer an MCP request.",
  advice: { explicitBucketBoundaries: MCP_SECONDS },
});
const sessionDuration = histogram("mcp.server.session.duration", {
  unit: "s",
  description: "How long an MCP client's connection to bayma lasted.",
  advice: { explicitBucketBoundaries: MCP_SECONDS },
});

/**
 * JSON-RPC errors that are the client's to fix, which the conventions do not
 * count as the server's failures: a malformed message, an unknown method,
 * invalid params, or a resource that does not exist.
 */
const CLIENT_ERROR_CODES = new Set([-32700, -32600, -32601, -32602, -32002]);

/** How a transport carries messages: over a pipe (stdio) or TCP (HTTP). */
export type NetworkTransport = "pipe" | "tcp";

/** The trace a request continues, from its _meta, or its HTTP headers. */
function propagatedContext(
  request: JSONRPCRequest,
  extra: MessageExtraInfo | undefined,
): Context {
  const meta = request.params?._meta;
  if (typeof meta?.[TRACEPARENT_META_KEY] === "string")
    return propagation.extract(ROOT_CONTEXT, {
      traceparent: meta[TRACEPARENT_META_KEY],
      tracestate: meta[TRACESTATE_META_KEY],
      baggage: meta[BAGGAGE_META_KEY],
    });
  const headers = extra?.request?.headers;
  if (!headers) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, headers, {
    keys: (carrier) => [...carrier.keys()],
    get: (carrier, key) => carrier.get(key) ?? undefined,
  });
}

/** What a request is, in the conventions' attributes, and its span's name. */
function describe(
  request: JSONRPCRequest,
  transport: Transport,
  networkTransport: NetworkTransport,
): { name: string; attributes: Attributes; metric: Attributes } {
  const metric: Attributes = {
    "mcp.method.name": request.method,
    "network.transport": networkTransport,
  };
  const attributes: Attributes = {
    ...metric,
    "jsonrpc.request.id": String(request.id),
    ...(transport.sessionId ? { "mcp.session.id": transport.sessionId } : {}),
  };
  const params = request.params as Record<string, unknown> | undefined;
  if (request.method === "tools/call" && typeof params?.name === "string") {
    metric["gen_ai.tool.name"] = params.name;
    Object.assign(attributes, {
      "gen_ai.tool.name": params.name,
      "gen_ai.operation.name": "execute_tool",
    });
    return { name: `tools/call ${params.name}`, attributes, metric };
  }
  if (request.method === "resources/read" && typeof params?.uri === "string")
    attributes["mcp.resource.uri"] = params.uri;
  return { name: request.method, attributes, metric };
}

/** How a response ended its request: the error it carries, if any. */
function outcome(
  message: JSONRPCMessage,
): { errorType: string; statusCode?: string; failed: boolean } | undefined {
  if (isJSONRPCErrorResponse(message)) {
    const code = message.error.code;
    return {
      errorType: String(code),
      statusCode: String(code),
      failed: !CLIENT_ERROR_CODES.has(code),
    };
  }
  if (
    isJSONRPCResultResponse(message) &&
    (message.result as { isError?: unknown }).isError === true
  )
    return { errorType: "tool_error", failed: true };
  return undefined;
}

interface Pending {
  span: Span;
  metric: Attributes;
  startedAt: number;
}

/**
 * Records the requests `transport` carries as server spans, each the active
 * span while bayma handles it, and how long each request and the connection
 * took. It wraps, in place, the handlers a server installs as it connects,
 * so it is called once the server has connected and before any message
 * arrives, which nothing but the transport's I/O can bring.
 */
export function traceMcpTransport(
  transport: Transport,
  networkTransport: NetworkTransport,
): void {
  const openedAt = performance.now();
  const pending = new Map<JSONRPCRequest["id"], Pending>();

  const deliver = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (!isJSONRPCRequest(message)) return deliver?.(message, extra);
    const parent = propagatedContext(message, extra);
    const { name, attributes, metric } = describe(
      message,
      transport,
      networkTransport,
    );
    const span = startSpan(name, attributes, parent, SpanKind.SERVER);
    pending.set(message.id, { span, metric, startedAt: performance.now() });
    context.with(trace.setSpan(parent, span), () => deliver?.(message, extra));
  };

  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (
      (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
      message.id !== undefined
    ) {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        finish(request, outcome(message));
      }
    }
    return send(message, options);
  };

  const closed = transport.onclose;
  transport.onclose = () => {
    for (const request of pending.values()) finish(request, undefined);
    pending.clear();
    sessionDuration.record((performance.now() - openedAt) / 1000, {
      "network.transport": networkTransport,
    });
    closed?.();
  };
}

function finish(
  { span, metric, startedAt }: Pending,
  ended: ReturnType<typeof outcome>,
): void {
  const errorAttributes: Attributes = ended
    ? {
        "error.type": ended.errorType,
        ...(ended.statusCode
          ? { "rpc.response.status_code": ended.statusCode }
          : {}),
      }
    : {};
  span.setAttributes(errorAttributes);
  if (ended?.failed) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
  operationDuration.record((performance.now() - startedAt) / 1000, {
    ...metric,
    ...errorAttributes,
  });
}
