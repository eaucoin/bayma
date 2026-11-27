import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { launchSpec, runSandboxHookCommand } from "../../support/runtimes.ts";
import { SOCKET_TEMP_ROOT } from "../../support/temp.ts";

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
  "a server records its sandbox's save and restore, exporting with the token its host gives it",
  async () => {
    const from = sink.authorizations.length;
    const server = await launchMcpHttpServer({
      env: exporting({
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20from-environment",
        OTEL_BSP_SCHEDULE_DELAY: "100",
      }),
      bearerToken: "first-token",
      telemetryToken: true,
    });
    /** The span named `name`, once the sink has it from this server. */
    const span = async (name: string): Promise<ReceivedSpan> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const found = sink.spans.find(
          (candidate) =>
            candidate.name === name &&
            candidate.resource["process.pid"] === server.child.pid,
        );
        if (found) return found;
        await sleep(50);
      }
      throw new Error(`the sink received no ${name} from the server`);
    };
    try {
      expect(await runSandboxHookCommand(server.stateDir, "save")).toEqual({
        status: 0,
        stderr: "",
      });
      await span("bayma.sandbox.save");
      writeFileSync(server.tokenFile, "second-token\n");
      expect(await runSandboxHookCommand(server.stateDir, "restore")).toEqual({
        status: 0,
        stderr: "",
      });
      const restored = await span("bayma.sandbox.restore");
      expect(restored.attributes["bayma.sandbox.saved.duration"]).toBeNumber();
    } finally {
      await server.close();
    }
    const authorizations = sink.authorizations.slice(from);
    expect(authorizations).toContain("Bearer first-token");
    expect(authorizations.at(-1)).toBe("Bearer second-token");
    expect(new Set(authorizations)).toEqual(
      new Set(["Bearer first-token", "Bearer second-token"]),
    );
  },
  TEST_TIMEOUT_MS,
);

/**
 * A way to the sink over TCP that, once `cut`, carries nothing more over the
 * connections it has, neither closing them nor answering on them, as a
 * restored sandbox's network carries none of the connections it had, while
 * it carries new ones as before.
 */
async function cuttableWayToSink(): Promise<{
  url: string;
  cut: () => void;
  close: () => Promise<void>;
}> {
  const sinkPort = Number(new URL(sink.url).port);
  const carried: { client: net.Socket; upstream: net.Socket }[] = [];
  const cutOff: net.Socket[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(sinkPort, "127.0.0.1");
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    carried.push({ client, upstream });
  });
  await new Promise<void>((listening) =>
    server.listen(0, "127.0.0.1", listening),
  );
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    cut: () => {
      for (const { client, upstream } of carried.splice(0)) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.destroy();
        cutOff.push(client);
      }
    },
    close: async () => {
      for (const socket of [
        ...cutOff,
        ...carried.flatMap(({ client, upstream }) => [client, upstream]),
      ])
        socket.destroy();
      await new Promise((closed) => server.close(closed));
    },
  };
}

test(
  "a server restored exports over connections of its own what it was exporting over its old ones, which carry nothing, and all it records next",
  async () => {
    const way = await cuttableWayToSink();
    const server = await launchMcpHttpServer({
      env: exporting({
        OTEL_EXPORTER_OTLP_ENDPOINT: way.url,
        OTEL_BSP_SCHEDULE_DELAY: "100",
        // Longer than the span below is waited for: an export sent over a
        // connection that carries nothing is not given up on meanwhile.
        OTEL_EXPORTER_OTLP_TIMEOUT: "30000",
      }),
    });
    /** The span named `name`, once the sink has it from this server. */
    const span = async (name: string): Promise<ReceivedSpan> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const found = sink.spans.find(
          (candidate) =>
            candidate.name === name &&
            candidate.resource["process.pid"] === server.child.pid,
        );
        if (found) return found;
        await sleep(50);
      }
      throw new Error(`the sink received no ${name} from the server`);
    };
    try {
      expect(await runSandboxHookCommand(server.stateDir, "save")).toEqual({
        status: 0,
        stderr: "",
      });
      // Exported over a connection the server keeps for the next export,
      // which then carries nothing: the resume's span is sent over it, and
      // goes unanswered, as the server is saved again and restored.
      await span("bayma.sandbox.save");
      way.cut();
      expect(await runSandboxHookCommand(server.stateDir, "resume")).toEqual({
        status: 0,
        stderr: "",
      });
      await sleep(500);
      expect(await runSandboxHookCommand(server.stateDir, "save")).toEqual({
        status: 0,
        stderr: "",
      });
      expect(await runSandboxHookCommand(server.stateDir, "restore")).toEqual({
        status: 0,
        stderr: "",
      });
      await span("bayma.sandbox.resume");
      await span("bayma.sandbox.restore");
    } finally {
      await server.close();
      await way.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a server exports what it holds as a save ends its sandbox, not as its next export is due",
  async () => {
    const server = await launchMcpHttpServer({
      env: exporting({
        // Far past the spans being waited for.
        OTEL_BSP_SCHEDULE_DELAY: "60000",
      }),
    });
    try {
      expect(await runSandboxHookCommand(server.stateDir, "save")).toEqual({
        status: 0,
        stderr: "",
      });
      // The save's own span, ended before the save answers, exported by then.
      expect(
        sink.spans.some(
          (candidate) =>
            candidate.name === "bayma.sandbox.save" &&
            candidate.resource["process.pid"] === server.child.pid,
        ),
      ).toBe(true);
      // The restore's span, held until a save ends the sandbox again.
      expect(await runSandboxHookCommand(server.stateDir, "restore")).toEqual({
        status: 0,
        stderr: "",
      });
      expect(await runSandboxHookCommand(server.stateDir, "save")).toEqual({
        status: 0,
        stderr: "",
      });
      expect(
        sink.spans.filter(
          (candidate) =>
            candidate.resource["process.pid"] === server.child.pid &&
            ["bayma.sandbox.save", "bayma.sandbox.restore"].includes(
              candidate.name,
            ),
        ).length,
      ).toBe(3);
    } finally {
      await server.close();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a server exports over HTTPS trusting the certificate OTEL_EXPORTER_OTLP_CERTIFICATE names",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-telemetry-tls-"));
    const cert = join(root, "cert.pem");
    const key = join(root, "key.pem");
    const made = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(made.stderr.toString()).not.toContain("error");
    expect(made.exitCode).toBe(0);
    // Self-signed, it is trusted only as the variable names it.
    const tlsSink = new OtlpSink({
      cert: await Bun.file(cert).text(),
      key: await Bun.file(key).text(),
    });
    const client = await McpStdioClient.connect({
      env: exporting({
        OTEL_EXPORTER_OTLP_ENDPOINT: tlsSink.url,
        OTEL_EXPORTER_OTLP_CERTIFICATE: cert,
        OTEL_BSP_SCHEDULE_DELAY: "100",
      }),
    });
    try {
      await client.client.listTools();
      const deadline = Date.now() + 10_000;
      while (
        !tlsSink.spans.some(({ name }) => name === "tools/list") &&
        Date.now() < deadline
      )
        await sleep(50);
      expect(tlsSink.spans.map(({ name }) => name)).toContain("tools/list");
    } finally {
      await client.close();
      tlsSink.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a server whose telemetry token is blank does not start; one reads it as it starts and again only as its sandbox is restored, and says once that it cannot read it then",
  async () => {
    // A state directory whose hook's socket path a Unix socket's may be.
    const root = mkdtempSync(join(SOCKET_TEMP_ROOT, "bayma-telemetry-token-"));
    const tokenFile = join(root, "token");
    const stateDir = join(root, "state");
    const launch = launchSpec();
    const serve = (env: Record<string, string>) =>
      Bun.spawn(
        [
          launch.command,
          ...launch.args,
          "mcp-http",
          "--port",
          "0",
          "--state-dir",
          stateDir,
          "--telemetry-token-file",
          tokenFile,
        ],
        { env: exporting(env), stdout: "ignore", stderr: "pipe" },
      );
    /** The bearers of the exports `act` leads to, once one has come. */
    const bearers = async (act: () => Promise<void>): Promise<string[]> => {
      const from = sink.authorizations.length;
      await act();
      const deadline = Date.now() + 10_000;
      while (sink.authorizations.length === from && Date.now() < deadline)
        await sleep(50);
      await sleep(500);
      return sink.authorizations.slice(from).map(String);
    };
    const hook = async (...modes: string[]) => {
      for (const mode of modes)
        expect(await runSandboxHookCommand(stateDir, mode)).toEqual({
          status: 0,
          stderr: "",
        });
    };
    try {
      writeFileSync(tokenFile, " \n");
      const blank = serve({});
      expect(await blank.exited).not.toBe(0);
      expect(await new Response(blank.stderr).text()).toContain(
        "telemetry bearer token must be non-empty, with no surrounding whitespace",
      );

      writeFileSync(tokenFile, "first-token\n");
      const server = serve({ OTEL_BSP_SCHEDULE_DELAY: "100" });
      expect(await bearers(async () => undefined)).toContain(
        "Bearer first-token",
      );
      // Gone, then another host's: the exports carry the token read as the
      // server started, the file never read meanwhile.
      rmSync(tokenFile);
      expect(new Set(await bearers(() => hook("save", "resume")))).toEqual(
        new Set(["Bearer first-token"]),
      );
      writeFileSync(tokenFile, "second-token\n");
      expect(new Set(await bearers(() => hook("save", "resume")))).toEqual(
        new Set(["Bearer first-token"]),
      );
      // Read again as the sandbox is restored, for its host.
      expect(await bearers(() => hook("save", "restore"))).toContain(
        "Bearer second-token",
      );
      // One it cannot read then: nothing is exported, which is said once.
      rmSync(tokenFile);
      await hook("save", "restore");
      await hook("save", "restore");
      const exportsAfter = sink.authorizations.length;
      await hook("save", "resume");
      await sleep(1_000);
      expect(sink.authorizations.length).toBe(exportsAfter);
      server.kill("SIGTERM");
      await server.exited;
      const said = await new Response(server.stderr).text();
      expect(said.split("bayma: telemetry: not exported: ").length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
