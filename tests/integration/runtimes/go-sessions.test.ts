import { expect, test } from "bun:test";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";

// What Go sessions do beyond the shared scenario corpus: a session that is
// one package, errors in the names the user wrote, and output that belongs to
// the cell that wrote it.

const EXEC_SETTLE_TIMEOUT_MS = 90_000;

async function createSession(client: McpStdioClient): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime: "go", title: "go-sessions", cwd: process.cwd() },
  );
  return created.session.session_id;
}

async function run(
  client: McpStdioClient,
  sessionId: string,
  code: string,
): Promise<ExecSnapshot> {
  return waitForSettledExec(
    client,
    sessionId,
    await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 1_000,
    }),
    { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
  );
}

test("a session is one package that grows a cell at a time", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client);
    // A type, its unexported method and field, and statements, in one cell.
    await run(
      client,
      session,
      "type tally struct{ n int }\n\nfunc (t *tally) add() { t.n++ }\n\ncount := &tally{}\ncount.add()",
    );
    expect(
      (await run(client, session, "count.add()\ncount.n")).result_text,
    ).toBe("2");
    await run(client, session, 'import "strings"');
    expect(
      (await run(client, session, 'strings.ToUpper("later")')).result_text,
    ).toBe("LATER");
    // A name declared again replaces the old one.
    await run(client, session, 'count := "replaced"');
    expect((await run(client, session, "count + count")).result_text).toBe(
      "replacedreplaced",
    );
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);

test("a compile error names what the user wrote, and the session keeps its state", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client);
    await run(client, session, "type tally struct{ n int }\ncount := &tally{}");
    const broken = await run(client, session, "count.missing");
    expect(broken.status).toBe("error");
    expect(broken.error_text).toBe(
      "count.missing undefined (type *tally has no field or method missing)",
    );
    expect((await run(client, session, "count.n")).result_text).toBe("0");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);

test("a panic ends only its cell", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client);
    await run(client, session, "kept := 41");
    const panicked = await run(client, session, 'kept++\npanic("boom")');
    expect(panicked.status).toBe("error");
    expect(panicked.error_text).toBe("panic: boom");
    // What the cell did before its panic stays done.
    expect((await run(client, session, "kept")).result_text).toBe("42");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);

test("output written while no cell runs is dropped", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client);
    await run(
      client,
      session,
      'import (\n\t"fmt"\n\t"time"\n)\ngo func() {\n\ttime.Sleep(100 * time.Millisecond)\n\tfmt.Println("late")\n}()',
    );
    await Bun.sleep(500);
    const next = await run(client, session, 'fmt.Println("next")');
    expect(next.stdout_text).toBe("next\n");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);

test("unexported fields reach later cells and stay out of JSON", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client);
    await run(
      client,
      session,
      'import "encoding/json"\ntype point struct {\n\tName   string\n\tsecret int\n}\nv := point{"a", 1}',
    );
    expect(
      (await run(client, session, "data, _ := json.Marshal(v)\nstring(data)"))
        .result_text,
    ).toBe('{"Name":"a"}');
    expect((await run(client, session, "v.secret")).result_text).toBe("1");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);
