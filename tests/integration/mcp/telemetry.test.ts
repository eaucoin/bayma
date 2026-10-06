import { afterAll, beforeAll, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { launchMcpHttpServer } from "../../support/mcp-http-client.ts";
import {
  McpStdioClient,
  processEnvironment,
} from "../../support/mcp-stdio-client.ts";
import {
  OtlpSink,
  type ReceivedMetric,
  type ReceivedSpan,
} from "../../support/otlp-sink.ts";

// A server configured to export telemetry records its requests and its
// sessions' work, continuing the trace each client propagates, and tells no
// REPL session where it exports.

const TEST_TIMEOUT_MS = 60_000;
const CLIENT_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const CLIENT_SPAN = "00f067aa0ba902b7";
const PROCESS_TRACE = "0af7651916cd43dd8448eb211c80319c";
const PROCESS_SPAN = "b7ad6b7169203331";

let sink: OtlpSink;

beforeAll(() => {
  sink = new OtlpSink();
});

afterAll(() => sink.stop());

/** The tests' environment, exporting to the sink. */
function exporting(env: Record<string, string> = {}): Record<string, string> {
  return {
    ...processEnvironment(),
    OTEL_EXPORTER_OTLP_ENDPOINT: sink.url,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    ...env,
  };
}

/** The span named `name` in `trace`, once the sink has it. */
async function received(trace: string, name: string): Promise<ReceivedSpan> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const span = sink.spans.find(
      (candidate) => candidate.traceId === trace && candidate.name === name,
    );
    if (span) return span;
    await sleep(50);
  }
  throw new Error(`the sink received no ${name} in trace ${trace}`);
}

/** The first reading of the metric named `name`, once the sink has one. */
async function readingOf(name: string): Promise<ReceivedMetric> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const metric = sink.metrics.find(
      (candidate) => candidate.name === name && candidate.points.length > 0,
    );
    if (metric) return metric;
    await sleep(50);
  }
  throw new Error(`the sink received no reading of ${name}`);
}

test(
  "a server over stdio records each request in its client's trace, and its sessions' work within it",
  async () => {
    const client = await McpStdioClient.connect({
      env: exporting({
        TRACEPARENT: `00-${PROCESS_TRACE}-${PROCESS_SPAN}-01`,
        // Often enough that the session below is not held open for long.
        OTEL_METRIC_EXPORT_INTERVAL: "100",
      }),
    });
    const _meta = { traceparent: `00-${CLIENT_TRACE}-${CLIENT_SPAN}-01` };
    let sessionId: string;
    try {
      const created = await client.client.callTool({
        name: "session.create",
        arguments: { runtime: "bun", title: "telemetry", cwd: process.cwd() },
        _meta,
      });
      sessionId = (
        created.structuredContent as { session: { session_id: string } }
      ).session.session_id;
      const executed = await client.client.callTool({
        name: "exec",
        arguments: {
          session_id: sessionId,
          code: "console.log(Object.keys(process.env).filter((name) => /^(OTEL_|TRACEPARENT|TRACESTATE)/.test(name)).length)",
        },
        _meta,
      });
      // A REPL session is told nothing of where its server exports.
      expect(
        (
          executed.structuredContent as { stdout_text: string }
        ).stdout_text.trim(),
      ).toBe("0");
      // The session gauge is read only at an export, and a session can open
      // and close between two, so this one stays open until it is read.
      expect((await readingOf("bayma.session.count")).points).toContainEqual(
        expect.objectContaining({ "bayma.runtime": "bun" }),
      );
      await client.client.callTool({
        name: "session.close",
        arguments: { session_id: sessionId },
        _meta,
      });
    } finally {
      await client.close();
    }

    // The requests continue the client's trace.
    const exec = await received(CLIENT_TRACE, "tools/call exec");
    expect(exec.parentSpanId).toBe(CLIENT_SPAN);
    expect(exec.resource["service.name"]).toBe("bayma");
    expect(exec.attributes).toMatchObject({
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "exec",
      "gen_ai.operation.name": "execute_tool",
      "network.transport": "pipe",
      "bayma.session.id": sessionId,
    });
    const create = await received(CLIENT_TRACE, "tools/call session.create");
    expect(create.attributes["bayma.runtime"]).toBe("bun");

    // The work each did is within it.
    const run = await received(CLIENT_TRACE, "bayma.exec");
    expect(run.parentSpanId).toBe(exec.spanId);
    expect(run.attributes["bayma.exec.id"]).toBe(
      exec.attributes["bayma.exec.id"],
    );
    expect(run.attributes["bayma.exec.status"]).toBe("ok");
    const start = await received(CLIENT_TRACE, "bayma.runtime.start");
    expect(start.parentSpanId).toBe(create.spanId);
    expect(start.attributes["bayma.runtime.start.reason"]).toBe("create");

    // The server's own start and stop continue the trace it was started in.
    for (const name of ["bayma.start", "bayma.shutdown"])
      expect((await received(PROCESS_TRACE, name)).parentSpanId).toBe(
        PROCESS_SPAN,
      );

    const started = sink.logs.find(
      (log) => log.body === `session ${sessionId} started`,
    );
    expect(started?.attributes["bayma.session.id"]).toBe(sessionId);
    const names = new Set(sink.metrics.map((metric) => metric.name));
    for (const name of [
      "mcp.server.operation.duration",
      "mcp.server.session.duration",
      "bayma.exec.duration",
      "bayma.runtime.start.duration",
    ])
      expect(names).toContain(name);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a server over HTTP continues the trace a client sends in its traceparent header",
  async () => {
    const server = await launchMcpHttpServer({ env: exporting() });
    const client = new Client({ name: "telemetry", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: { traceparent: `00-${CLIENT_TRACE}-${CLIENT_SPAN}-01` },
          },
        }),
      );
      await client.listTools();
    } finally {
      await client.close();
      // Stopped as `docker stop` stops it, for it to export what it holds.
      const exited = new Promise((resolve) =>
        server.child.once("exit", resolve),
      );
      server.child.kill("SIGTERM");
      await exited;
      await server.close();
    }
    const listed = await received(CLIENT_TRACE, "tools/list");
    expect(listed.parentSpanId).toBe(CLIENT_SPAN);
    expect(listed.attributes["network.transport"]).toBe("tcp");
    expect(listed.attributes["mcp.session.id"]).toBeString();
  },
  TEST_TIMEOUT_MS,
);

test(
  "a server names the signals it is configured to export and cannot",
  async () => {
    const client = await McpStdioClient.connect({
      env: exporting({ OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc" }),
    });
    try {
      expect(client.serverOutput()).toContain(
        "bayma: telemetry: traces: bayma exports over http/protobuf or http/json, not grpc",
      );
    } finally {
      await client.close();
    }
  },
  TEST_TIMEOUT_MS,
);
