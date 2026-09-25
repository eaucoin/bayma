import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLBELT_DIR } from "@bayma/core";
import { writeTree } from "../../support/native-fixtures.ts";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";

// Source and type inspection in C#, C, C++, Lean, and Go sessions, done the
// way each runtime skill's Source And Type Inspection section says.

const EXEC_SETTLE_TIMEOUT_MS = 300_000;
const toolbelt = join(process.env.BAYMA_PAYLOAD_DIR!, TOOLBELT_DIR);

async function createSession(
  client: McpStdioClient,
  runtime: RuntimeId,
  cwd: string,
): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime, title: `inspection-${runtime}`, cwd },
  );
  return created.session.session_id;
}

async function run(
  client: McpStdioClient,
  sessionId: string,
  code: string,
): Promise<ExecSnapshot> {
  const exec = await waitForSettledExec(
    client,
    sessionId,
    await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 1_000,
    }),
    { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
  );
  expect(exec.error_text).toBe("");
  expect(exec.status).toBe("ok");
  return exec;
}

/** A project directory, removed after `body`. */
async function withProject(
  tree: Record<string, string>,
  body: (project: string) => Promise<void>,
): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), "bayma-inspection-"));
  try {
    writeTree(project, tree);
    await body(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

test("C# inspects a project through Roslyn's Workspaces from the toolbelt", async () => {
  await withProject(
    {
      "Ledger.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup>",
        "    <TargetFramework>net10.0</TargetFramework>",
        "    <ImplicitUsings>enable</ImplicitUsings>",
        "  </PropertyGroup>",
        "</Project>",
      ].join("\n"),
      "Ledger.cs": [
        "namespace Accounts;",
        "/// <summary>A running balance.</summary>",
        "public interface ILedger { void Record(decimal amount); }",
        "public sealed class Ledger : ILedger {",
        "  private readonly List<decimal> entries = new();",
        "  public void Record(decimal amount) => entries.Add(amount);",
        "}",
        "public static class Usage { public static void Run(ILedger l) => l.Record(5m); }",
      ].join("\n"),
    },
    async (project) => {
      await withMcpStdio(async (client) => {
        const session = await createSession(client, "dotnet-script", project);
        const inspected = await run(
          client,
          session,
          [
            ...[
              "Microsoft.CodeAnalysis",
              "Microsoft.CodeAnalysis.CSharp",
              "Microsoft.CodeAnalysis.Workspaces",
              "Microsoft.CodeAnalysis.CSharp.Workspaces",
              "Microsoft.CodeAnalysis.Workspaces.MSBuild",
            ].map(
              (assembly) =>
                `#r ${JSON.stringify(join(toolbelt, "dotnet", `${assembly}.dll`))}`,
            ),
            "using Microsoft.CodeAnalysis;",
            "using Microsoft.CodeAnalysis.CSharp.Formatting;",
            "using Microsoft.CodeAnalysis.FindSymbols;",
            "using Microsoft.CodeAnalysis.Host.Mef;",
            "using Microsoft.CodeAnalysis.MSBuild;",
            "var workspace = MSBuildWorkspace.Create(MefHostServices.Create(new[] { typeof(Workspace).Assembly, typeof(CSharpFormattingOptions).Assembly, typeof(MSBuildWorkspace).Assembly }));",
            'var project = await workspace.OpenProjectAsync(Path.GetFullPath("Ledger.csproj"));',
            "var compilation = (await project.GetCompilationAsync())!;",
            'var ledger = compilation.GetTypeByMetadataName("Accounts.ILedger")!;',
            'var record = ledger.GetMembers("Record").Single();',
            "var callers = await SymbolFinder.FindCallersAsync(record, workspace.CurrentSolution);",
            "var implementations = await SymbolFinder.FindImplementationsAsync(ledger, workspace.CurrentSolution);",
            'string.Join(" | ", new[] { compilation.GetDiagnostics().Count(d => d.Severity == DiagnosticSeverity.Error).ToString(), ledger.GetDocumentationCommentXml()!.Contains("A running balance") ? "documented" : "undocumented", string.Join(",", callers.Select(c => c.CallingSymbol.ToDisplayString())), string.Join(",", implementations.Select(i => i.ToDisplayString())) })',
          ].join("\n"),
        );
        expect(inspected.result_text).toBe(
          '"0 | documented | Accounts.Usage.Run(Accounts.ILedger) | Accounts.Ledger"',
        );
        await client.callTool("session.close", { session_id: session });
      });
    },
  );
}, 600_000);

/** A C or C++ cell's libclang probe of `file`, as the skill describes it. */
function libclangProbe(hostVariable: string, file: string): string {
  return [
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "#include <unistd.h>",
    "#include <clang-c/Index.h>",
    "#include <clang-c/CXCompilationDatabase.h>",
    "",
    "static enum CXChildVisitResult print_declaration(CXCursor cursor, CXCursor parent, CXClientData data) {",
    "  if (clang_Location_isInSystemHeader(clang_getCursorLocation(cursor))) return CXChildVisit_Continue;",
    "  if (clang_isDeclaration(clang_getCursorKind(cursor))) {",
    "    CXString usr = clang_getCursorUSR(cursor);",
    '    printf("%s\\n", clang_getCString(usr));',
    "    clang_disposeString(usr);",
    "  }",
    "  return CXChildVisit_Recurse;",
    "}",
    "",
    "static int inspect(void) {",
    "  CXCompilationDatabase_Error error;",
    '  CXCompilationDatabase db = clang_CompilationDatabase_fromDirectory(".", &error);',
    `  CXCompileCommands commands = clang_CompilationDatabase_getCompileCommands(db, ${JSON.stringify(file)});`,
    "  CXCompileCommand command = clang_CompileCommands_getCommand(commands, 0);",
    "  unsigned argc = clang_CompileCommand_getNumArgs(command);",
    "  const char *argv[32];",
    "  CXString owned[32];",
    `  argv[0] = getenv("${hostVariable}");`,
    "  for (unsigned i = 1; i < argc && i < 32; i++) {",
    "    owned[i] = clang_CompileCommand_getArg(command, i);",
    "    argv[i] = clang_getCString(owned[i]);",
    "  }",
    "  CXTranslationUnit unit = 0;",
    "  clang_parseTranslationUnit2FullArgv(clang_createIndex(0, 0), 0, argv, (int)argc, 0, 0, CXTranslationUnit_None, &unit);",
    "  unsigned errors = 0;",
    "  for (unsigned i = 0; i < clang_getNumDiagnostics(unit); i++) {",
    "    CXDiagnostic d = clang_getDiagnostic(unit, i);",
    "    if (clang_getDiagnosticSeverity(d) >= CXDiagnostic_Error) errors++;",
    "    clang_disposeDiagnostic(d);",
    "  }",
    '  printf("errors %u\\n", errors);',
    "  clang_visitChildren(clang_getTranslationUnitCursor(unit), print_declaration, 0);",
    "  return 0;",
    "}",
    "",
    "inspect();",
  ].join("\n");
}

test("C and C++ inspect a project through the libclang their runtimes carry", async () => {
  await withProject(
    {
      "queue.h":
        "#include <stddef.h>\n/** A bounded ring. */\nstruct queue { int *items; size_t head, tail; };\nint queue_pop(struct queue *q);\n",
      "queue.c":
        '#include "queue.h"\nint queue_pop(struct queue *q) { return q->items[q->head++]; }\n',
      "shapes.cpp": [
        "#include <string>",
        "namespace geometry {",
        "struct Shape { virtual ~Shape() = default; virtual double area() const = 0; };",
        "struct Circle : Shape { double area() const override { return 3.0; } std::string name; };",
        "}",
      ].join("\n"),
    },
    async (project) => {
      // A build writes its compilation database with absolute directories.
      writeTree(project, {
        "compile_commands.json": JSON.stringify([
          {
            directory: project,
            file: "queue.c",
            arguments: ["clang", "-c", "queue.c"],
          },
          {
            directory: project,
            file: "shapes.cpp",
            arguments: [
              "clang++",
              "-std=c++23",
              "-stdlib=libc++",
              "-c",
              "shapes.cpp",
            ],
          },
        ]),
      });
      await withMcpStdio(async (client) => {
        const c = await createSession(client, "c", project);
        const inC = await run(
          client,
          c,
          libclangProbe("BAYMA_C_HOST_BIN", join(project, "queue.c")),
        );
        expect(inC.stdout_text).toContain("errors 0\n");
        expect(inC.stdout_text).toContain("c:@S@queue\n");
        expect(inC.stdout_text).toContain("c:@F@queue_pop\n");

        const cpp = await createSession(client, "cpp", project);
        const inCpp = await run(
          client,
          cpp,
          libclangProbe("BAYMA_CPP_HOST_BIN", join(project, "shapes.cpp")),
        );
        expect(inCpp.stdout_text).toContain("errors 0\n");
        expect(inCpp.stdout_text).toContain("c:@N@geometry@S@Circle\n");
        expect(inCpp.stdout_text).toContain(
          "c:@N@geometry@S@Circle@F@area#1\n",
        );
        for (const session of [c, cpp])
          await client.callTool("session.close", { session_id: session });
      });
    },
  );
}, 600_000);

test("Lean inspects its environment and the toolchain's .ilean references", async () => {
  await withProject({}, async (project) => {
    await withMcpStdio(async (client) => {
      const session = await createSession(client, "lean", project);
      const inspected = await run(
        client,
        session,
        [
          "import Lean",
          "open Lean Meta",
          "",
          "#eval show MetaM Unit from do",
          "  let info ← getConstInfo ``List.map",
          "  let doc ← findDocString? (← getEnv) ``List.map",
          '  IO.println s!"type {← ppExpr info.type}"',
          '  IO.println s!"documented {doc.isSome}"',
          '  let ilean ← Lean.Server.Ilean.load ((← findSysroot) / "lib" / "lean" / "Init" / "Data" / "List" / "Basic.ilean")',
          "  let mut uses := 0",
          "  for (ident, info) in ilean.references do",
          '    if let .const _ name := ident then if name == "List.map" then uses := uses + info.usages.size',
          '  IO.println s!"used {decide (uses > 0)}"',
        ].join("\n"),
      );
      // What the #eval printed is the cell's one message, and so its result.
      expect(inspected.result_text).toBe(
        [
          "type {α : Type u_1} → {β : Type u_2} → (α → β) → List α → List β",
          "documented true",
          "used true",
        ].join("\n"),
      );
      await client.callTool("session.close", { session_id: session });
    });
  });
}, 600_000);

test("Go type-checks a module's package with its standard library, from any cell", async () => {
  await withProject(
    {
      "go.mod": "module ledger\n\ngo 1.26\n",
      "ledger.go": [
        "// Package ledger keeps a running balance.",
        "package ledger",
        "",
        'import "errors"',
        "",
        "// ErrEmpty is the error of a ledger with nothing recorded.",
        'var ErrEmpty = errors.New("empty")',
        "",
        "// A Ledger records amounts.",
        "type Ledger struct{ entries []int }",
        "",
        "// Record adds an amount.",
        "func (l *Ledger) Record(amount int) { l.entries = append(l.entries, amount) }",
      ].join("\n"),
    },
    async (project) => {
      await withMcpStdio(async (client) => {
        const session = await createSession(client, "go", project);
        await run(
          client,
          session,
          [
            "import (",
            '\t"go/ast"',
            '\t"go/build"',
            '\t"go/doc"',
            '\t"go/importer"',
            '\t"go/parser"',
            '\t"go/token"',
            '\t"go/types"',
            '\t"path/filepath"',
            ")",
            "",
            "func inspect(dir string) (*types.Package, *doc.Package, error) {",
            "\tfset := token.NewFileSet()",
            "\tpkg, err := build.ImportDir(dir, 0)",
            "\tif err != nil {",
            "\t\treturn nil, nil, err",
            "\t}",
            "\tvar files []*ast.File",
            "\tfor _, name := range pkg.GoFiles {",
            "\t\tfile, err := parser.ParseFile(fset, filepath.Join(dir, name), nil, parser.ParseComments)",
            "\t\tif err != nil {",
            "\t\t\treturn nil, nil, err",
            "\t\t}",
            "\t\tfiles = append(files, file)",
            "\t}",
            '\tchecked, err := (&types.Config{Importer: importer.ForCompiler(fset, "source", nil)}).Check(pkg.ImportPath, fset, files, nil)',
            "\tif err != nil {",
            "\t\treturn nil, nil, err",
            "\t}",
            "\tdocs, err := doc.NewFromFiles(fset, files, pkg.ImportPath)",
            "\treturn checked, docs, err",
            "}",
          ].join("\n"),
        );
        // A later cell calls the earlier cell's inspection.
        const inspected = await run(
          client,
          session,
          [
            'checked, docs, err := inspect(".")',
            "if err != nil {",
            "\tpanic(err)",
            "}",
            'record, _, _ := types.LookupFieldOrMethod(types.NewPointer(checked.Scope().Lookup("Ledger").Type()), true, checked, "Record")',
            '[]string{docs.Doc, record.Type().String(), checked.Scope().Lookup("ErrEmpty").Type().String()}',
          ].join("\n"),
        );
        expect(inspected.result_text).toBe(
          "[Package ledger keeps a running balance.\n func(amount int) error]",
        );
        await client.callTool("session.close", { session_id: session });
      });
    },
  );
}, 600_000);
