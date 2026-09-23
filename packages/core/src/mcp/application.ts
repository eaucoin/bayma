import { McpServer } from "@modelcontextprotocol/server";
import { BAYMA_VERSION } from "../version.ts";
import type { SessionManager } from "../session/session-manager.ts";
import { registerMcpResources } from "./resources.ts";
import { registerMcpTools } from "./tools.ts";
import { validateSnapshotTokenLimit } from "./exec-snapshot.ts";
import type { ModelSurface } from "./model-surface.ts";

interface ToolContext {
  sessionId?: string;
}

export interface McpApplication {
  server: McpServer;
  subscriptions: Set<string>;
}

export function createMcpApplication(
  manager: SessionManager,
  resolveActorId: (context: ToolContext) => string,
  snapshotTokenLimit: number,
  modelSurface: ModelSurface,
): McpApplication {
  validateSnapshotTokenLimit(snapshotTokenLimit);
  const subscriptions = new Set<string>();
  const server = new McpServer(
    {
      name: modelSurface.serverName,
      version: BAYMA_VERSION,
    },
    {
      capabilities: {
        logging: {},
        resources: {
          subscribe: true,
        },
      },
      instructions: modelSurface.instructions,
    },
  );

  server.server.setRequestHandler("resources/subscribe", async (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler("resources/unsubscribe", async (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  registerMcpResources(server, manager);
  registerMcpTools(server, manager, resolveActorId, snapshotTokenLimit);

  return {
    server,
    subscriptions,
  };
}
