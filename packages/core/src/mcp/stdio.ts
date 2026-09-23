import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { aggregateFailure, failureDetail } from "../errors.ts";
import type { RuntimeAdapter } from "../runtime/adapter.ts";
import { createEngine } from "../engine.ts";
import type { SessionManagerOptions } from "../session/session-manager.ts";
import { createMcpApplication } from "./application.ts";
import { createModelSurface } from "./model-surface.ts";
import { SubscribedResourceUpdatePublisher } from "./events.ts";
import { shutdownAndExit } from "./shutdown.ts";
import { validateSnapshotTokenLimit } from "./exec-snapshot.ts";

export interface McpStdioConfig extends Pick<
  SessionManagerOptions,
  "resolveCreatePolicy"
> {
  stateDir: string;
  maxSessions: number;
  warnUsagePercent: number;
  snapshotTokenLimit: number;
  defaultCols: number;
  defaultRows: number;
}

const STDIO_ACTOR_ID = "actor_mcp_stdio";

export async function serveMcpStdio(
  adapters: readonly RuntimeAdapter[],
  config: McpStdioConfig,
): Promise<never> {
  validateSnapshotTokenLimit(config.snapshotTokenLimit);
  let application: ReturnType<typeof createMcpApplication> | undefined;
  let updates: SubscribedResourceUpdatePublisher | undefined;

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
      updates?.publish(envelope.event);
    },
  );
  const { manager } = engine;

  application = createMcpApplication(
    manager,
    () => STDIO_ACTOR_ID,
    config.snapshotTokenLimit,
    createModelSurface(engine.registry, config.snapshotTokenLimit),
  );
  updates = new SubscribedResourceUpdatePublisher(
    application.server,
    application.subscriptions,
  );

  const transport = new StdioServerTransport();
  application.server.server.onerror = (error) => {
    process.stderr.write(failureDetail(error) + "\n");
  };
  let connected = false;
  let closeObserved = false;
  application.server.server.onclose = () => {
    closeObserved = true;
    if (connected) shutdownAndExit(engine.shutdown);
  };

  try {
    await application.server.connect(transport);
  } catch (error) {
    const cleanup = await Promise.allSettled([
      application.server.close(),
      engine.shutdown(),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw aggregateFailure(
        "MCP stdio connection failed and cleanup was incomplete",
        [error, ...failures],
      );
    }
    throw error;
  }
  connected = true;
  if (closeObserved) shutdownAndExit(engine.shutdown);
  return new Promise<never>(() => undefined);
}
