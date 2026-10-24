import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { SessionManager } from "../session/session-manager.ts";
import { SERVER_EVENTS_URI, SESSIONS_URI, sessionUri } from "./uris.ts";

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function templateValue(value: string | string[], name: string): string {
  if (typeof value !== "string") {
    throw new Error(
      `resource template parameter ${name} must occur exactly once`,
    );
  }
  return value;
}

export function registerMcpResources(
  server: McpServer,
  manager: SessionManager,
): void {
  server.registerResource(
    "sessions",
    SESSIONS_URI,
    {
      title: "Sessions",
      description:
        "Known Bayma sessions, including non-live recoverable state.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: jsonText({ sessions: manager.list() }),
        },
      ],
    }),
  );

  server.registerResource(
    "server-events",
    SERVER_EVENTS_URI,
    {
      title: "Server Events",
      description: "Recent server-level lifecycle events.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: jsonText({ events: manager.serverEvents() }),
        },
      ],
    }),
  );

  server.registerResource(
    "session",
    new ResourceTemplate("bayma:///session/{sessionId}", {
      list: async () => ({
        resources: manager.list().map((session) => ({
          uri: sessionUri(session.sessionId),
          name: session.title,
        })),
      }),
    }),
    {
      title: "Session",
      description:
        "Status and metadata for a single session, including ownership and execution history.",
      mimeType: "application/json",
    },
    async (uri, { sessionId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: jsonText({
            session: manager.detail(templateValue(sessionId, "sessionId")),
          }),
        },
      ],
    }),
  );

  // An exec's resources are its template's alone, never listed: every exec of every session
  // listed came to more than a client takes in one message (16.9 MB from about 200 sessions).
  // A client knows its execs' IDs from exec and wait, and a session's latest from its resource.
  server.registerResource(
    "session-exec",
    new ResourceTemplate("bayma:///session/{sessionId}/exec/{execId}", {
      list: undefined,
    }),
    {
      title: "Execution",
      description:
        "Status, timing, code, and message summary for a single exec.",
      mimeType: "application/json",
    },
    async (uri, { sessionId, execId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: jsonText({
            sessionId: templateValue(sessionId, "sessionId"),
            exec: manager.exec(
              templateValue(sessionId, "sessionId"),
              templateValue(execId, "execId"),
            ),
          }),
        },
      ],
    }),
  );

  server.registerResource(
    "session-exec-messages",
    new ResourceTemplate(
      "bayma:///session/{sessionId}/exec/{execId}/messages",
      { list: undefined },
    ),
    {
      title: "Execution Messages",
      description:
        "Ordered stdout, stderr, result, error, and image messages for a single exec.",
      mimeType: "application/json",
    },
    async (uri, { sessionId, execId }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: jsonText({
            sessionId: templateValue(sessionId, "sessionId"),
            execId: templateValue(execId, "execId"),
            messages: manager.execMessages(
              templateValue(sessionId, "sessionId"),
              templateValue(execId, "execId"),
            ),
          }),
        },
      ],
    }),
  );

  server.registerResource(
    "session-exec-image",
    new ResourceTemplate(
      "bayma:///session/{sessionId}/exec/{execId}/image/{seq}",
      { list: undefined },
    ),
    {
      title: "Execution Image",
      description:
        "An image an exec showed, as the image message at seq of its messages.",
    },
    async (uri, { sessionId, execId, seq }) => {
      const image = manager.execImage(
        templateValue(sessionId, "sessionId"),
        templateValue(execId, "execId"),
        Number(templateValue(seq, "seq")),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: image.mimeType,
            blob: image.bytes.toString("base64"),
          },
        ],
      };
    },
  );
}
