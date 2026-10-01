import { McpHttpClient } from "./mcp-http-client.ts";

// A client process for a test to kill, as a client that exits without ending
// its MCP session: it connects to the MCP HTTP server at its first argument,
// creates a Bun session, prints the session's id and its own MCP session's id
// as one JSON line, and stays connected.

const client = await McpHttpClient.connect(process.argv[2]!);
const created = await client.callTool<{ session: { session_id: string } }>(
  "session.create",
  { runtime: "bun", title: "abandoned", cwd: process.cwd() },
);
console.log(
  JSON.stringify({
    sessionId: created.session.session_id,
    mcpSessionId: client.mcpSessionId,
  }),
);
setInterval(() => undefined, 60_000);
