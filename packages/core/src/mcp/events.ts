import type { McpServer } from "@modelcontextprotocol/server";
import type { SessionEvent } from "../session/events.ts";
import {
  SERVER_EVENTS_URI,
  SESSIONS_URI,
  sessionExecMessagesUri,
  sessionExecUri,
  sessionUri,
} from "./uris.ts";

function isSessionListMutation(event: SessionEvent): boolean {
  return (
    event.type === "session/started" ||
    event.type === "session/closed" ||
    event.type === "exec/started"
  );
}

function resourceUpdateUris(event: SessionEvent): Set<string> {
  const uris = new Set<string>([SERVER_EVENTS_URI]);
  if (event.type === "session/pressureWarning") {
    uris.add(SESSIONS_URI);
  }
  const sessionId = "sessionId" in event ? event.sessionId : undefined;
  const execId = "execId" in event ? event.execId : undefined;
  if (sessionId) {
    uris.add(SESSIONS_URI);
    uris.add(sessionUri(sessionId));
    if (execId) {
      uris.add(sessionExecUri(sessionId, execId));
      uris.add(sessionExecMessagesUri(sessionId, execId));
    }
  }
  return uris;
}

async function publishUris(
  server: McpServer,
  uris: Iterable<string>,
): Promise<void> {
  await Promise.all(
    [...uris].map((uri) =>
      server.server
        .sendResourceUpdated({
          uri,
        })
        .catch(() => undefined),
    ),
  );
}

export class SubscribedResourceUpdatePublisher {
  private readonly pendingUris = new Set<string>();
  private listChangePending = false;
  private drainPromise?: Promise<void>;

  private readonly server: McpServer;
  private readonly subscriptions: ReadonlySet<string>;

  constructor(server: McpServer, subscriptions: ReadonlySet<string>) {
    this.server = server;
    this.subscriptions = subscriptions;
  }

  publish(event: SessionEvent): void {
    this.listChangePending ||= isSessionListMutation(event);
    for (const uri of resourceUpdateUris(event)) {
      if (this.subscriptions.has(uri)) this.pendingUris.add(uri);
    }
    this.startDrain();
  }

  async flush(): Promise<void> {
    while (this.drainPromise) await this.drainPromise;
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
      if (this.listChangePending || this.pendingUris.size > 0) {
        this.startDrain();
      }
    });
  }

  private async drain(): Promise<void> {
    while (this.listChangePending || this.pendingUris.size > 0) {
      const publishListChange = this.listChangePending;
      const uris = [...this.pendingUris];
      this.listChangePending = false;
      this.pendingUris.clear();
      if (publishListChange) {
        await this.server.server
          .sendResourceListChanged()
          .catch(() => undefined);
      }
      await publishUris(this.server, uris);
    }
  }
}
