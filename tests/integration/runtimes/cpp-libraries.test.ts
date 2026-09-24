import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSharedLibrary,
  writeTree,
} from "../../support/native-fixtures.ts";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";

// C and C++ sessions with a project's own settings and libraries: what a
// session's compile_flags.txt sets, libraries loaded as a program's would be,
// and what cells share with them.

const EXEC_SETTLE_TIMEOUT_MS = 90_000;
const linux = process.platform === "linux";

async function createSession(
  client: McpStdioClient,
  runtime: "c" | "cpp",
  cwd: string,
): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime, title: `${runtime}-libraries`, cwd },
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

/** A project directory, removed after `body`. */
async function withProject(
  body: (project: string) => Promise<void>,
): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), "bayma-cpp-project-"));
  try {
    await body(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("a cell that cannot link is undone, and the session goes on", async () => {
  await withProject(async (project) => {
    writeTree(project, {
      "once.h": "#pragma once\nstruct Once { int value = 9; };\n",
      "guarded.h": [
        "#ifndef GUARDED_H",
        "#define GUARDED_H",
        "struct Guarded { int value = 11; };",
        "#endif",
      ].join("\n"),
    });
    await withMcpStdio(async (client) => {
      for (const runtime of ["c", "cpp"] as const) {
        const session = await createSession(client, runtime, project);
        await run(client, session, "int kept = 42;");
        const missing = await run(
          client,
          session,
          "int missing(void);\nint (*value)(void) = missing;",
        );
        expect(missing.status).toBe("error");
        expect(missing.error_text).toContain(
          "the cell uses what nothing defines: missing",
        );
        // What the failed cell declared is gone: the name is free again.
        const value = await run(client, session, "int value = 3;\nvalue");
        expect(value.result_text).toBe("3");
        expect((await run(client, session, "kept")).result_text).toBe("42");
        await client.callTool("session.close", { session_id: session });
      }

      // A failed cell's own code and macros are undone; the headers it
      // included that parsed stay included, standard ones among them.
      const session = await createSession(client, "cpp", project);
      const failed = await run(
        client,
        session,
        [
          "#include <vector>",
          '#include "once.h"',
          '#include "guarded.h"',
          "#define LIMIT 5",
          "struct Item { int value; };",
          "std::vector<Item> items{{1}, {2}};",
          "int broken = nope;",
        ].join("\n"),
      );
      expect(failed.status).toBe("error");
      expect(
        (await run(client, session, "int fine = 5;\nfine")).result_text,
      ).toBe("5");
      const again = await run(
        client,
        session,
        [
          "#include <vector>",
          '#include "once.h"',
          '#include "guarded.h"',
          "#ifdef LIMIT",
          "int limit = LIMIT;",
          "#else",
          "int limit = -1;",
          "#endif",
          "struct Item { int value; };",
          "std::vector<Item> items{{3}, {4}};",
          'std::string("still ") + std::to_string(Once{}.value + Guarded{}.value + limit + int(items.size()))',
        ].join("\n"),
      );
      expect(again.result_text).toBe('"still 21"');

      // A header that failed to parse can be included again once it is
      // fixed.
      writeTree(project, { "broken.h": "int broken() { return nope; }\n" });
      expect((await run(client, session, '#include "broken.h"')).status).toBe(
        "error",
      );
      writeTree(project, { "broken.h": "int broken() { return 4; }\n" });
      expect(
        (await run(client, session, '#include "broken.h"\nbroken()'))
          .result_text,
      ).toBe("4");
      await client.callTool("session.close", { session_id: session });
    });
  });
}, 240_000);

test("compile_flags.txt sets a session's include directories, definitions, and standard", async () => {
  await withProject(async (project) => {
    writeTree(project, {
      "include/greeting.h":
        "inline const char *greeting() { return GREETING; }\n",
      "compile_flags.txt": [
        "-I",
        "include",
        '-DGREETING="hello"',
        "-std=c++17",
        "-std=c17",
      ].join("\n"),
    });
    await withMcpStdio(async (client) => {
      const cpp = await createSession(client, "cpp", project);
      expect(
        (await run(client, cpp, "#include <greeting.h>\ngreeting()"))
          .result_text,
      ).toBe('"hello"');
      expect((await run(client, cpp, "__cplusplus")).result_text).toBe(
        "201703",
      );
      // Numbers print without std::format, which C++17 lacks.
      expect((await run(client, cpp, "1.0 / 3")).result_text).toBe(
        "0.3333333333333333",
      );
      await client.callTool("session.close", { session_id: cpp });

      // A C session takes the C standard and leaves the C++ one.
      const c = await createSession(client, "c", project);
      expect((await run(client, c, "__STDC_VERSION__")).result_text).toBe(
        "201710",
      );
      await client.callTool("session.close", { session_id: c });
    });
  });
}, 240_000);

const SHAPES_HEADER = `#pragma once
#include <exception>
#include <string>
namespace shapes {
struct Shape {
  virtual ~Shape();
};
template <class T> struct Box : Shape {
  T value;
  explicit Box(T value) : value(value) {}
};
template <class T> struct Failure : std::exception {
  T code;
  explicit Failure(T code) : code(code) {}
  const char *what() const noexcept override { return "shapes"; }
};
int unbox(const Shape &shape);
void fail(int code);
extern thread_local int calls;
inline int bump() { return ++calls; }
int callsSeen();
std::string color(int code);
} // namespace shapes
`;

const SHAPES_SOURCE = `#include <shapes.h>
std::string colorName(int code);
namespace shapes {
Shape::~Shape() = default;
int unbox(const Shape &shape) {
  auto *box = dynamic_cast<const Box<int> *>(&shape);
  return box ? box->value : -1;
}
void fail(int code) { throw Failure<int>(code); }
thread_local int calls = 0;
int callsSeen() { return calls; }
std::string color(int code) { return colorName(code); }
} // namespace shapes
`;

test.skipIf(!linux)(
  "cells share a library's types, exceptions, and thread-locals, and load it with what it needs",
  async () => {
    await withProject(async (project) => {
      const lib = join(project, "lib");
      const include = join(project, "include");
      writeTree(include, { "shapes.h": SHAPES_HEADER });
      buildSharedLibrary(
        {
          name: "libcolor.so",
          stdlib: "libc++",
          sources: {
            "color.cpp":
              '#include <string>\nstd::string colorName(int code) { return code == 1 ? "red" : "blue"; }\n',
          },
        },
        lib,
        include,
      );
      buildSharedLibrary(
        {
          name: "libshapes.so",
          stdlib: "libc++",
          sources: { "shapes.cpp": SHAPES_SOURCE },
          needs: ["libcolor.so"],
        },
        lib,
        include,
      );
      writeFileSync(
        join(project, "compile_flags.txt"),
        ["-isystem", "include", "-Llib", "-lshapes"].join("\n"),
      );
      await withMcpStdio(async (client) => {
        const session = await createSession(client, "cpp", project);
        await run(client, session, "#include <shapes.h>\n#include <thread>");
        // The library's dynamic_cast knows a Box<int> the cell made.
        expect(
          (await run(client, session, "shapes::unbox(shapes::Box<int>(42))"))
            .result_text,
        ).toBe("42");
        // The cell catches what the library throws, by its type.
        const caught = await run(
          client,
          session,
          [
            'std::string caught = "nothing";',
            "try {",
            "  shapes::fail(7);",
            "} catch (const shapes::Failure<int> &failure) {",
            '  caught = "Failure<int> " + std::to_string(failure.code);',
            "}",
            "caught",
          ].join("\n"),
        );
        expect(caught.result_text).toBe('"Failure<int> 7"');
        // An inline function in the headers reaches the library's
        // thread-local: each thread its own.
        await run(
          client,
          session,
          [
            "int seenOnAnotherThread() {",
            "  int seen = 0;",
            "  std::thread([&] {",
            "    shapes::bump();",
            "    seen = shapes::callsSeen();",
            "  }).join();",
            "  return seen;",
            "}",
          ].join("\n"),
        );
        expect(
          (
            await run(
              client,
              session,
              'shapes::bump();\nshapes::bump();\nstd::to_string(shapes::callsSeen()) + " " + std::to_string(seenOnAnotherThread())',
            )
          ).result_text,
        ).toBe('"2 1"');
        // libshapes needs libcolor, which has no runpath to be found by.
        expect(
          (await run(client, session, "shapes::color(1)")).result_text,
        ).toBe('"red"');
        await client.callTool("session.close", { session_id: session });
      });
    });
  },
  240_000,
);

test.skipIf(!linux)(
  "a session can use libstdc++, as a distribution's C++ libraries do",
  async () => {
    await withProject(async (project) => {
      const lib = join(project, "lib");
      const include = join(project, "include");
      writeTree(include, {
        "once.h": [
          "#pragma once",
          "#include <mutex>",
          "#include <string>",
          "#include <vector>",
          "namespace once {",
          "inline std::once_flag &flag() {",
          "  static std::once_flag flag;",
          "  return flag;",
          "}",
          "int ran();",
          "std::string joined(const std::vector<std::string> &words);",
          "} // namespace once",
        ].join("\n"),
      });
      buildSharedLibrary(
        {
          name: "libonce.so",
          stdlib: "libstdc++",
          sources: {
            "once.cpp": [
              "#include <once.h>",
              "namespace once {",
              "static int count = 0;",
              "int ran() {",
              "  std::call_once(flag(), [] { ++count; });",
              "  return count;",
              "}",
              "std::string joined(const std::vector<std::string> &words) {",
              "  std::string out;",
              "  for (const auto &word : words) out += word;",
              "  return out;",
              "}",
              "} // namespace once",
            ].join("\n"),
          },
        },
        lib,
        include,
      );
      writeFileSync(
        join(project, "compile_flags.txt"),
        ["-stdlib=libstdc++", "-isystem", "include", "-Llib", "-lonce"].join(
          "\n",
        ),
      );
      await withMcpStdio(async (client) => {
        const session = await createSession(client, "cpp", project);
        await run(
          client,
          session,
          [
            "#include <once.h>",
            "int alsoRan() {",
            "  static int count = 0;",
            "  std::call_once(once::flag(), [] { ++count; });",
            "  return count;",
            "}",
          ].join("\n"),
        );
        // One once_flag, whether the library or the cell calls it.
        expect(
          (
            await run(
              client,
              session,
              'std::to_string(once::ran()) + " " + std::to_string(alsoRan())',
            )
          ).result_text,
        ).toBe('"1 0"');
        expect(
          (await run(client, session, 'once::joined({"lib", "stdc++"})'))
            .result_text,
        ).toBe('"libstdc++"');
        await client.callTool("session.close", { session_id: session });
      });
    });
  },
  240_000,
);

test("a library compile_flags.txt names that cannot load keeps the session from starting", async () => {
  await withProject(async (project) => {
    writeFileSync(join(project, "compile_flags.txt"), "-lnowhere\n");
    await withMcpStdio(async (client) => {
      const created = await client.callToolResult("session.create", {
        runtime: "cpp",
        title: "cpp-libraries",
        cwd: project,
      });
      expect(created.isError).toBe(true);
      expect(JSON.stringify(created.content)).toContain(
        "compile_flags.txt: cannot load -lnowhere",
      );
    });
  });
}, 240_000);
