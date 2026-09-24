import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { ATTR } from "../../tooling/src/telemetry/attributes.ts";
import { outputLog } from "../../tooling/src/telemetry/index.ts";
import {
  launchSpec,
  MCP_REQUEST_TIMEOUT_MS,
  MCP_RESOURCE_TIMEOUT_MS,
  type LaunchSpec,
  type RuntimeId,
} from "./runtimes.ts";

const MCP_TEST_CLOSE_TIMEOUT_MS = 6_000;
const MCP_TEST_EXEC_SETTLE_TIMEOUT_MS = 20_000;

export function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export interface ExecSnapshot {
  session_id: string;
  exec_id: string;
  runtime: RuntimeId;
  status: string;
  done?: boolean;
  next_seq?: number;
  stdout_text?: string;
  stderr_text?: string;
  result_text?: string;
  error_text?: string;
  truncated?: boolean;
  original_token_count?: number;
}

export interface WaitForSettledExecOptions {
  timeoutMs?: number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

interface ResourceUpdateWaiter {
  predicate: (uri: string) => boolean;
  resolve: (uri: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class McpStdioClient {
  readonly resourceUpdates: string[] = [];
  private readonly waiters = new Set<ResourceUpdateWaiter>();

  readonly client: Client;
  private readonly tempRoot: string;
  private readonly serverStderr: string[];

  private constructor(
    client: Client,
    tempRoot: string,
    serverStderr: string[],
  ) {
    this.client = client;
    this.tempRoot = tempRoot;
    this.serverStderr = serverStderr;
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

  static async connect(
    options: {
      stateDir?: string;
      defaultDurability?: "ephemeral" | "checkpointed";
      env?: Record<string, string>;
    } = {},
  ): Promise<McpStdioClient> {
    return McpStdioClient.launch(launchSpec(), options);
  }

  /** Connect to any command that serves `mcp-stdio`, e.g. an installed launcher. */
  static async launch(
    launch: LaunchSpec,
    options: {
      stateDir?: string;
      defaultDurability?: "ephemeral" | "checkpointed";
      env?: Record<string, string>;
    } = {},
  ): Promise<McpStdioClient> {
    const tempRoot = mkdtempSync(join(tmpdir(), "bayma-mcp-"));
    const stateDir = options.stateDir ?? join(tempRoot, "state");
    const client = new Client({ name: "bayma-test-client", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: [
        ...launch.args,
        "mcp-stdio",
        "--state-dir",
        stateDir,
        "--default-durability",
        options.defaultDurability ?? "ephemeral",
      ],
      cwd: process.cwd(),
      env: options.env ?? processEnvironment(),
      stderr: "pipe",
    });
    const serverStderr: string[] = [];
    const serverLog = outputLog("stderr", {
      [ATTR.serverTransport]: "stdio",
    });
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      const text = Buffer.from(chunk).toString("utf8");
      serverStderr.push(text);
      serverLog?.write(text);
    });
    transport.stderr?.on("end", () => serverLog?.end());
    try {
      await client.connect(transport);
      return new McpStdioClient(client, tempRoot, serverStderr);
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      try {
        await client.close();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "MCP stdio connection failed and cleanup was incomplete",
        );
      }
      throw error;
    }
  }

  async listTools(): Promise<string[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => tool.name);
  }

  async listToolDefinitions() {
    const result = await this.client.listTools();
    return result.tools;
  }

  async listResources(): Promise<string[]> {
    const result = await this.client.listResources();
    return result.resources.map((resource) => resource.uri);
  }

  async listResourceTemplates(): Promise<string[]> {
    const result = await this.client.listResourceTemplates();
    return result.resourceTemplates.map((resource) => resource.uriTemplate);
  }

  async subscribeResource(uri: string): Promise<void> {
    await this.client.subscribeResource({ uri });
  }

  async callToolResult(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult & { isError: boolean }> {
    let rawResult: Awaited<ReturnType<Client["callTool"]>>;
    try {
      rawResult = await this.client.callTool(
        { name, arguments: args },
        { timeout: MCP_REQUEST_TIMEOUT_MS },
      );
    } catch (error) {
      const stderr = this.serverStderr.join("").trim();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        stderr ? `${message}\nserver stderr:\n${stderr}` : message,
        { cause: error },
      );
    }
    const result = CallToolResultSchema.parse(rawResult);
    return {
      ...result,
      isError: Boolean(result.isError),
    };
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.callToolResult(name, args);
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
    while (Date.now() < deadline) {
      const value = await this.readJsonResource<T>(uri);
      if (predicate(value)) return value;
      await sleep(intervalMs);
    }
    throw new Error(`timed out waiting for resource ${uri}`);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await withMcpCloseTimeout(this.client.close());
    } catch (error) {
      failures.push(error);
    }
    try {
      rmSync(this.tempRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP stdio client cleanup failed");
    }
  }
}

async function withMcpCloseTimeout(operation: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `MCP stdio client close did not settle within ${MCP_TEST_CLOSE_TIMEOUT_MS}ms`,
              ),
            ),
          MCP_TEST_CLOSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function appendResultText(existing: string, next: string): string {
  if (existing.length === 0) return next;
  if (existing.endsWith("\n") || next.startsWith("\n")) return existing + next;
  return `${existing}\n${next}`;
}

function mergeSnapshotText(
  previous: ExecSnapshot,
  next: ExecSnapshot,
): Pick<
  ExecSnapshot,
  "stdout_text" | "stderr_text" | "result_text" | "error_text"
> {
  const previousStdout = previous.stdout_text ?? "";
  const previousStderr = previous.stderr_text ?? "";
  const previousResult = previous.result_text ?? "";
  const previousError = previous.error_text ?? "";
  const nextStdout = next.stdout_text ?? "";
  const nextStderr = next.stderr_text ?? "";
  const nextResult = next.result_text ?? "";
  const nextError = next.error_text ?? "";

  return {
    stdout_text: previousStdout + nextStdout,
    stderr_text: previousStderr + nextStderr,
    result_text:
      nextResult.length === 0
        ? previousResult
        : appendResultText(previousResult, nextResult),
    error_text:
      nextError.length === 0
        ? previousError
        : appendResultText(previousError, nextError),
  };
}

function mergeExecSnapshots(
  previous: ExecSnapshot,
  next: ExecSnapshot,
): ExecSnapshot {
  return {
    ...next,
    ...mergeSnapshotText(previous, next),
  };
}

function isSettled(snapshot: ExecSnapshot): boolean {
  return (
    snapshot.done !== false &&
    (snapshot.status === "ok" ||
      snapshot.status === "error" ||
      snapshot.status === "interrupted")
  );
}

export async function waitForSettledExec(
  client: Pick<McpStdioClient, "callTool">,
  sessionId: string,
  snapshot: ExecSnapshot,
  options: WaitForSettledExecOptions = {},
): Promise<ExecSnapshot> {
  let current = snapshot;
  let accumulated = snapshot;
  let fromSeq = current.next_seq ?? 1;
  const deadline =
    Date.now() + (options.timeoutMs ?? MCP_TEST_EXEC_SETTLE_TIMEOUT_MS);
  const yieldTimeMs = options.yieldTimeMs ?? 1_000;

  while (Date.now() < deadline) {
    if (isSettled(current)) {
      return accumulated;
    }
    current = await client.callTool<ExecSnapshot>("wait", {
      session_id: sessionId,
      exec_id: snapshot.exec_id,
      from_seq: fromSeq,
      yield_time_ms: yieldTimeMs,
      ...(options.maxOutputTokens === undefined
        ? {}
        : { max_output_tokens: options.maxOutputTokens }),
    });
    accumulated = mergeExecSnapshots(accumulated, current);
    fromSeq = current.next_seq ?? fromSeq;
  }

  throw new Error(`exec ${snapshot.exec_id} did not settle`);
}

export async function withMcpStdio<T>(
  fn: (client: McpStdioClient) => Promise<T>,
  options: {
    stateDir?: string;
    defaultDurability?: "ephemeral" | "checkpointed";
    env?: Record<string, string>;
  } = {},
): Promise<T> {
  const client = await McpStdioClient.connect(options);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
