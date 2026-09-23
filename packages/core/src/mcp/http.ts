import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import http from "node:http";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { isInitializeRequest } from "@modelcontextprotocol/server";
import { aggregateFailure, failureDetail } from "../errors.ts";
import type { RuntimeAdapter } from "../runtime/adapter.ts";
import { createEngine } from "../engine.ts";
import type { SessionManagerOptions } from "../session/session-manager.ts";
import { createMcpApplication, type McpApplication } from "./application.ts";
import { createModelSurface } from "./model-surface.ts";
import { SubscribedResourceUpdatePublisher } from "./events.ts";
import { shutdownAndExit } from "./shutdown.ts";
import { createOpaqueId } from "../ids.ts";
import { validateSnapshotTokenLimit } from "./exec-snapshot.ts";

export interface McpHttpConfig extends Pick<
  SessionManagerOptions,
  "resolveCreatePolicy"
> {
  host: string;
  port: number;
  path: string;
  stateDir: string;
  maxSessions: number;
  warnUsagePercent: number;
  snapshotTokenLimit: number;
  defaultCols: number;
  defaultRows: number;
}

interface HttpClientSession {
  application: McpApplication;
  transport: NodeStreamableHTTPServerTransport;
  updates: SubscribedResourceUpdatePublisher;
  close: () => Promise<void>;
}

const MAX_MCP_HTTP_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

class HttpRequestError extends Error {
  readonly statusCode: number;
  readonly rpcCode: number;

  constructor(statusCode: number, rpcCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.rpcCode = rpcCode;
  }
}

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  body: { jsonrpc: "2.0"; error: { code: number; message: string }; id: null },
): void {
  if (response.headersSent) return;
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  let requestError: HttpRequestError | undefined;
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) ||
      !Number.isSafeInteger(Number(contentLength)))
  ) {
    requestError = new HttpRequestError(
      400,
      -32600,
      "invalid content-length header",
    );
  }
  if (contentLength && Number(contentLength) > MAX_MCP_HTTP_BODY_BYTES) {
    requestError = new HttpRequestError(
      413,
      -32001,
      `MCP request body exceeds ${MAX_MCP_HTTP_BODY_BYTES} bytes`,
    );
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    if (requestError) continue;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_MCP_HTTP_BODY_BYTES) {
      chunks.length = 0;
      requestError = new HttpRequestError(
        413,
        -32001,
        `MCP request body exceeds ${MAX_MCP_HTTP_BODY_BYTES} bytes`,
      );
      continue;
    }
    chunks.push(bytes);
  }
  if (requestError) throw requestError;
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpRequestError(400, -32700, "invalid JSON request body");
  }
}

export async function serveMcpHttp(
  adapters: readonly RuntimeAdapter[],
  config: McpHttpConfig,
): Promise<never> {
  validateSnapshotTokenLimit(config.snapshotTokenLimit);
  if (
    !Number.isSafeInteger(config.port) ||
    config.port < 0 ||
    config.port > 65_535
  ) {
    throw new Error("MCP HTTP port must be an integer between 0 and 65535");
  }
  if (!config.host.trim()) {
    throw new Error("MCP HTTP host must not be empty");
  }
  const configuredPath = new URL(config.path, "http://bayma.invalid");
  if (
    !config.path.startsWith("/") ||
    configuredPath.pathname !== config.path ||
    configuredPath.search ||
    configuredPath.hash
  ) {
    throw new Error("MCP HTTP path must be one absolute URL pathname");
  }
  const sessions = new Map<string, HttpClientSession>();

  const engine = await createEngine(
    adapters,
    {
      stateDir: config.stateDir,
      maxSessions: config.maxSessions,
      warnUsagePercent: config.warnUsagePercent,
      defaultCols: config.defaultCols,
      defaultRows: config.defaultRows,
      resolveCreatePolicy: config.resolveCreatePolicy,
    },
    (envelope) => {
      for (const session of sessions.values()) {
        session.updates.publish(envelope.event);
      }
    },
  );
  const { manager } = engine;

  // A loopback server refuses requests whose Host or Origin is not local, so
  // a browser page cannot reach it through DNS rebinding.
  const guardLoopbackRequest = LOOPBACK_HOSTS.has(config.host.toLowerCase())
    ? (() => {
        const validateHost = localhostHostValidation();
        const validateOrigin = localhostOriginValidation();
        return (request: http.IncomingMessage, response: http.ServerResponse) =>
          validateHost(request, response) && validateOrigin(request, response);
      })()
    : undefined;

  const server = http.createServer(async (request, response) => {
    if (guardLoopbackRequest && !guardLoopbackRequest(request, response))
      return;
    if (!request.url) {
      response.statusCode = 404;
      response.end();
      return;
    }

    let url: URL;
    try {
      // Routing depends only on the request target. The Host header is
      // untrusted input and must not participate in URL parsing.
      url = new URL(request.url, "http://bayma.invalid");
    } catch {
      response.statusCode = 400;
      response.end("invalid request target");
      return;
    }
    if (url.pathname !== config.path) {
      response.statusCode = 404;
      response.end();
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    const headerSessionId =
      typeof sessionId === "string" ? sessionId : undefined;

    try {
      if (request.method === "POST") {
        const body = await readJsonBody(request);

        if (headerSessionId) {
          const existing = sessions.get(headerSessionId);
          if (!existing) {
            sendJson(response, 404, {
              jsonrpc: "2.0",
              error: {
                code: -32004,
                message: "unknown MCP session",
              },
              id: null,
            });
            return;
          }
          await existing.transport.handleRequest(request, response, body);
          return;
        }

        if (!isInitializeRequest(body)) {
          sendJson(response, 400, {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "missing MCP session and initialize request",
            },
            id: null,
          });
          return;
        }

        const pendingActorId = createOpaqueId("actor_mcp_http_pending");
        const actorIdForSession = (sessionId?: string): string =>
          sessionId ? `actor_mcp_http_${sessionId}` : pendingActorId;
        let cleanupPromise: Promise<void> | undefined;
        const closeClientSession = (
          closingSessionId?: string,
        ): Promise<void> => {
          if (!closingSessionId) return Promise.resolve();
          cleanupPromise ??= (async () => {
            sessions.delete(closingSessionId);
            await manager.releaseActor(actorIdForSession(closingSessionId));
          })();
          return cleanupPromise;
        };
        let clientSession: HttpClientSession | undefined;
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => {
            while (true) {
              const candidate = randomUUID();
              if (!sessions.has(candidate)) return candidate;
            }
          },
          onsessioninitialized: (initializedSessionId) => {
            if (!clientSession) return;
            sessions.set(initializedSessionId, clientSession);
          },
          onsessionclosed: closeClientSession,
        });
        const application = createMcpApplication(
          manager,
          (context) => actorIdForSession(context.sessionId),
          config.snapshotTokenLimit,
          createModelSurface(engine.registry, config.snapshotTokenLimit),
        );
        clientSession = {
          application,
          transport,
          updates: new SubscribedResourceUpdatePublisher(
            application.server,
            application.subscriptions,
          ),
          close: () => closeClientSession(transport.sessionId),
        };

        transport.onclose = () => {
          void closeClientSession(transport.sessionId).catch((error) => {
            process.stderr.write(
              `Failed to release MCP HTTP actor: ${failureDetail(error)}\n`,
            );
          });
        };
        application.server.server.onerror = (error) => {
          process.stderr.write(failureDetail(error) + "\n");
        };
        try {
          await application.server.connect(transport);
          await transport.handleRequest(request, response, body);
        } catch (error) {
          const initializedSessionId = transport.sessionId;
          const cleanup = await Promise.allSettled([
            application.server.close(),
            closeClientSession(initializedSessionId),
          ]);
          const cleanupFailures = cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (cleanupFailures.length > 0) {
            throw aggregateFailure(
              "MCP HTTP initialization failed and cleanup was incomplete",
              [error, ...cleanupFailures],
            );
          }
          throw error;
        }
        return;
      }

      if (request.method === "GET" || request.method === "DELETE") {
        if (!headerSessionId) {
          response.statusCode = 400;
          response.end("missing MCP session");
          return;
        }
        const existing = sessions.get(headerSessionId);
        if (!existing) {
          response.statusCode = 404;
          response.end("unknown MCP session");
          return;
        }
        await existing.transport.handleRequest(request, response);
        return;
      }

      response.statusCode = 405;
      response.end();
    } catch (error) {
      const message = failureDetail(error);
      process.stderr.write(message + "\n");
      if (!response.headersSent) {
        const requestError =
          error instanceof HttpRequestError ? error : undefined;
        sendJson(response, requestError?.statusCode ?? 500, {
          jsonrpc: "2.0",
          error: {
            code: requestError?.rpcCode ?? -32603,
            message: requestError?.message ?? "internal server error",
          },
          id: null,
        });
      } else {
        response.end();
      }
    }
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once("error", onError);
      server.listen(config.port, config.host, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  } catch (error) {
    try {
      await engine.shutdown();
    } catch (shutdownError) {
      throw aggregateFailure(
        "MCP HTTP listen failed and engine cleanup was incomplete",
        [error, shutdownError],
      );
    }
    throw error;
  }

  let shuttingDown = false;
  const shutdown = (exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownAndExit(async () => {
      const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
          } else {
            resolveClose();
          }
        });
      });
      const clients = [...sessions.values()];
      sessions.clear();
      const cleanup = await Promise.allSettled([
        serverClosed,
        ...clients.map((session) => session.application.server.close()),
        ...clients.map((session) => session.close()),
      ]);
      const failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      try {
        await engine.shutdown();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw aggregateFailure("HTTP MCP shutdown failed", failures);
      }
    }, exitCode);
  };

  server.on("error", (error) => {
    process.stderr.write(`MCP HTTP server failed: ${failureDetail(error)}\n`);
    shutdown(1);
  });
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  return new Promise<never>(() => undefined);
}
