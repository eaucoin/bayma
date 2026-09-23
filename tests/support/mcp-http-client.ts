import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { launchSpec, MCP_RESOURCE_TIMEOUT_MS } from "./runtimes.ts";

const MCP_HTTP_CLOSE_TIMEOUT_MS = 1_000;
interface ResourceUpdateWaiter {
  predicate: (uri: string) => boolean;
  resolve: (uri: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class McpHttpClient {
  readonly resourceUpdates: string[] = [];
  private readonly waiters = new Set<ResourceUpdateWaiter>();
  private closed = false;

  readonly client: Client;
  private readonly transport: StreamableHTTPClientTransport;

  private constructor(
    client: Client,
    transport: StreamableHTTPClientTransport,
  ) {
    this.client = client;
    this.transport = transport;
    client.setNotificationHandler(
      "notifications/resources/updated",
      (notification) => {
        const uri = notification.params.uri;
        this.resourceUpdates.push(uri);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(uri)) {
            clearTimeout(waiter.timeout);
            this.waiters.delete(waiter);
            waiter.resolve(uri);
          }
        }
      },
    );
  }

  static async connect(url: string): Promise<McpHttpClient> {
    const client = new Client({
      name: "bayma-http-test-client",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    try {
      await client.connect(transport);
      return new McpHttpClient(client, transport);
    } catch (error) {
      try {
        await client.close();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "MCP HTTP connection failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async subscribeResource(uri: string): Promise<void> {
    await this.client.subscribeResource({ uri });
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = CallToolResultSchema.parse(
      await this.client.callTool({ name, arguments: args }),
    );
    if (result.isError) {
      const message = result.content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text",
        )
        .map((item) => item.text)
        .join("\n");
      throw new Error(message || `tool ${name} failed`);
    }
    return result.structuredContent as T;
  }

  async readJsonResource<T>(uri: string): Promise<T> {
    const result = await this.client.readResource({ uri });
    const text = result.contents.find(
      (content): content is { uri: string; mimeType?: string; text: string } =>
        "text" in content,
    )?.text;
    if (!text) {
      throw new Error(`resource ${uri} did not contain text`);
    }
    return JSON.parse(text) as T;
  }

  waitForResourceUpdate(
    predicate: (uri: string) => boolean,
    timeoutMs = MCP_RESOURCE_TIMEOUT_MS,
  ): Promise<string> {
    const existing = this.resourceUpdates.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("timed out waiting for resource update"));
      }, timeoutMs);
      const waiter: ResourceUpdateWaiter = {
        predicate,
        resolve,
        reject,
        timeout,
      };
      this.waiters.add(waiter);
    });
  }

  async waitForJsonResource<T>(
    uri: string,
    predicate: (value: T) => boolean,
    timeoutMs = MCP_RESOURCE_TIMEOUT_MS,
    intervalMs = 100,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastValue: T | undefined;
    while (Date.now() < deadline) {
      const value = await this.readJsonResource<T>(uri);
      lastValue = value;
      if (predicate(value)) return value;
      await sleep(intervalMs);
    }
    throw new Error(
      `timed out waiting for resource ${uri}; last value: ${JSON.stringify(lastValue)}`,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const failures: unknown[] = [];
    try {
      await withCloseTimeout(
        this.transport.terminateSession(),
        "MCP HTTP session termination",
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await withCloseTimeout(this.client.close(), "MCP HTTP client close");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP HTTP client cleanup failed");
    }
  }
}

async function withCloseTimeout<T>(
  operation: Promise<T>,
  description: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `${description} did not settle within ${MCP_HTTP_CLOSE_TIMEOUT_MS}ms`,
              ),
            ),
          MCP_HTTP_CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export interface McpHttpServerOptions {
  /** Launch this binary instead of the source entrypoint. */
  binary?: string;
  maxSessions?: number;
  warnUsagePercent?: number;
  stateDir?: string;
  defaultDurability?: "ephemeral" | "checkpointed";
}

export interface McpHttpServer {
  child: ChildProcess;
  url: string;
  stateDir: string;
  binary: string;
  spawnClient: () => Promise<McpHttpClient>;
  stop: () => Promise<void>;
  close: () => Promise<void>;
}

export async function launchMcpHttpServer(
  options: McpHttpServerOptions = {},
): Promise<McpHttpServer> {
  const launch = options.binary
    ? { command: options.binary, args: [], binaryLabel: options.binary }
    : launchSpec();

  const root = mkdtempSync(join(tmpdir(), "bayma-mcp-http-"));
  const port = await reservePort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const stateDir = options.stateDir ?? join(root, "state");
  const child = spawn(
    launch.command,
    [
      ...launch.args,
      "mcp-http",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--path",
      "/mcp",
      "--state-dir",
      stateDir,
      "--default-durability",
      options.defaultDurability ?? "ephemeral",
      "--max-sessions",
      String(options.maxSessions ?? 8),
      "--warn-usage-percent",
      String(options.warnUsagePercent ?? 75),
    ],
    {
      detached: true,
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    },
  );
  child.unref();

  try {
    await waitForHttpServer(url);
  } catch (error) {
    child.ref();
    terminateChild(child);
    await waitForChildExit(child);
    closeChildPipes(child);
    child.unref();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.ref();
    terminateChild(child);
    await waitForChildExit(child);
    closeChildPipes(child);
    child.unref();
  };

  return {
    child,
    url,
    stateDir,
    binary: launch.binaryLabel,
    spawnClient: () => McpHttpClient.connect(url),
    stop,
    close: async () => {
      await stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function withMcpHttpServer<T>(
  fn: (server: McpHttpServer & { client: McpHttpClient }) => Promise<T>,
  options: McpHttpServerOptions = {},
): Promise<T> {
  const server = await launchMcpHttpServer(options);
  let client: McpHttpClient | undefined;
  try {
    client = await server.spawnClient();
    return await fn({ ...server, client });
  } finally {
    const failures: unknown[] = [];
    try {
      await client?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await server.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP HTTP server cleanup failed");
    }
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHttpServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: "probe" }),
      });
      if (response.status >= 400) {
        return;
      }
    } catch {
      await sleep(50);
      continue;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for MCP HTTP server at ${url}`);
}

function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child pid if the process group is already gone.
    }
  }
  child.kill("SIGKILL");
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onExit: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        onExit = resolve;
        child.once("exit", onExit);
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("MCP HTTP child did not exit after SIGKILL")),
          1_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onExit) child.off("exit", onExit);
  }
}

function closeChildPipes(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
