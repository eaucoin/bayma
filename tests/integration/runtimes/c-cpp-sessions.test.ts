import { expect, test } from "bun:test";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";

// What C and C++ sessions do beyond the shared scenario corpus: results that
// show what they hold, and cells that take their process down without taking
// the session with them.

const EXEC_SETTLE_TIMEOUT_MS = 90_000;

async function createSession(
  client: McpStdioClient,
  runtime: "c" | "cpp",
): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime, title: `${runtime}-sessions`, cwd: process.cwd() },
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

test("C++ results show what they hold", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client, "cpp");
    await run(
      client,
      session,
      "#include <map>\n#include <ostream>\n#include <string>\n#include <vector>",
    );
    await run(client, session, "std::vector<int> values{1, 2, 3};");
    expect((await run(client, session, "values")).result_text).toBe(
      "[1, 2, 3]",
    );
    expect(
      (await run(client, session, 'std::string("say \\"hi\\"")')).result_text,
    ).toBe('"say \\"hi\\""');
    expect(
      (await run(client, session, 'std::map<std::string, int>{{"a", 1}}'))
        .result_text,
    ).toBe('{"a": 1}');
    // A type of the session's own, printed through its operator<<.
    await run(
      client,
      session,
      [
        "struct Point { int x, y; };",
        "std::ostream &operator<<(std::ostream &out, const Point &p) {",
        '  return out << "(" << p.x << ", " << p.y << ")";',
        "}",
      ].join("\n"),
    );
    expect((await run(client, session, "Point{1, 2}")).result_text).toBe(
      "(1, 2)",
    );
    // One that cannot be printed shows its type and where it lives.
    await run(client, session, "struct Opaque { int hidden; };");
    expect((await run(client, session, "Opaque{7}")).result_text).toStartWith(
      "(Opaque) @0x",
    );
    // A temporary whose destructor is a template's, which Clang's own value
    // capture could not link.
    expect(
      (
        await run(
          client,
          session,
          'std::map<std::string, std::vector<int>>{{"name", {2, 4, 6}}}',
        )
      ).result_text,
    ).toBe('{"name": [2, 4, 6]}');
    expect((await run(client, session, "values.size()")).result_text).toBe("3");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);

test("a compile error is the exec's error, and the session keeps its state", async () => {
  await withMcpStdio(async (client) => {
    for (const runtime of ["c", "cpp"] as const) {
      const session = await createSession(client, runtime);
      await run(client, session, "int kept = 42;");
      const broken = await run(client, session, "int broken = nope;");
      expect(broken.status).toBe("error");
      expect(broken.error_text).toContain(
        "use of undeclared identifier 'nope'",
      );
      // Clang compiles each exec as if included from a main file; saying so
      // tells the reader nothing.
      expect(broken.error_text).not.toContain("In file included from");
      expect((await run(client, session, "kept")).result_text).toBe("42");
      await client.callTool("session.close", { session_id: session });
    }
  });
}, 240_000);

test("a cell that ends its process ends only that exec", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client, "cpp");
    const failures = [
      {
        code: "int kept = 1;\nint *nothing = nullptr;\n*nothing = 1;",
        says: "The cell was ended by signal",
      },
      {
        code: '#include <stdexcept>\nthrow std::runtime_error("escaped");',
        says: "uncaught exception: escaped",
      },
      {
        code: "#include <cstdlib>\nstd::exit(3);",
        says: "The cell ended the process with exit status 3.",
      },
    ];
    for (const failure of failures) {
      const ended = await run(client, session, failure.code);
      expect(ended.status).toBe("error");
      expect(ended.error_text).toContain(failure.says);
      expect(ended.error_text).toContain("continues in a fresh interpreter");
      const next = await run(client, session, "40 + 2");
      expect(next.status).toBe("ok");
      expect(next.result_text).toBe("42");
    }
    // The fresh interpreter starts empty.
    const forgotten = await run(client, session, "kept");
    expect(forgotten.status).toBe("error");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);
