---
name: bayma-runtime-dotnet-script
description: Execute C# code interactively in a persistent bayma dotnet-script session; create and manage multiple sessions, and use its tools for code, repositories, and source and type inspection.
---

# C# Runtime

Use bayma's C# dotnet-script runtime when executable memory will help. A session is an interactive workbench: script state, imports, references, clients, datasets, intermediate results, helpers, and evolving program state can remain available while you write, execute, inspect results, and revise.

The goal is not merely to run C# code. It is to avoid repeatedly reconstructing the same context and to support a coherent body of interactive work over time.

If you are reading this skill, make sure that you can see all of bayma's tools loaded among your other tools, under whatever prefix your client gives them, such as `mcp__bayma__session_create`:

- `exec`
- `wait`
- `session.acquire_controller`
- `session.close`
- `session.create`
- `session.interrupt`
- `session.release_controller`
- `session.resize`

Create sessions with `runtime: "dotnet-script"`; the selected runtime remains fixed for the session lifetime. Do not run throwaway `dotnet` projects or one-off script executions instead of using bayma.

## Choose The Workbench

- Continue in the current session when the next step belongs to the same body of work and its accumulated script state is still useful.
- After a restart, interruption, or genuine change of task, inspect `bayma:///sessions` and recover the C# workbench that best preserves the relevant context.
- Reuse based on continuity of work: the same objective, `cwd`, references, data, clients, intermediate state, and intended output. A matching `cwd` is necessary for source and metadata resolution, but it is not by itself a reason to combine unrelated work.
- Create a new session for clean-room validation, a different checkout, incompatible or misleading state, or truly independent concurrent work.
- Do not create a separate session merely because another assembly or domain becomes involved. One session can accumulate several cooperating references and objects when that makes the ongoing work easier to continue.

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the task meaningfully changes.

## Work Interactively

Use short cells to perform the next meaningful step. Review the resulting state, then write or execute the next cell. Prefer several legible cells over a giant script that performs the entire workflow without an opportunity to adapt.

Important: when deriving a REPL output, transform the value into a representation that removes repeated structure, factors shared structure into common parents, and omits values that can be derived from other values already present. Preserve enough information to reconstruct the original value, then choose the valid serialized form that makes the REPL output shortest.

Retain state that will make later reasoning cheaper or more precise:

- imported namespaces and loaded references;
- initialized clients and service objects;
- parsed datasets, indexes, and query results;
- intermediate calculations and comparison baselines;
- discovered capabilities, constraints, and reusable helpers.

Give retained state descriptive domain names. Do not initialize generic caches, notes collections, or REPL scaffolding merely to prove the session is persistent.

Persistent memory does not make facts timeless. Refresh external observations when freshness matters, and replace state that has become stale, ambiguous, or invalid.

## Continue Safely

- If an exec is still running, continue it with `wait`; do not duplicate it.
- After a disconnect or uncertain tool result, inspect the durable session and exec records before resubmitting code.
- Reacquire the known workbench after interruption when its context remains useful.
- Inspect controller ownership, queue state, recovery, or quarantine details only when an actual coordination or lifecycle concern requires it.
- Leave a useful workbench available for later continuation. Release control when another actor should use it. Close it only when it is disposable, invalid, or more confusing than starting over.

## Session Lifecycle

Workbench usefulness remains the primary selection criterion; these states matter when coordination or recovery does.

- `live_idle`: continue when the workbench is relevant; acquire control if unowned.
- `live_busy`: inspect the active and queued execs, then wait or observe rather than duplicating work.
- `suspended`: reacquire and resume when its retained purpose and checkpoint remain useful.
- `recovering`: wait for recovery to settle before deciding what to do next.
- `quarantined`: inspect the reason; replace the session unless the underlying fault is explicitly repaired.
- `closed`, or announced for eviction by a `session/evictionScheduled` event: do not select for new work.

Controller authority is exclusive. Do not steal or close another actor's session. Observe it, wait for release, or create a separate workbench only for genuinely independent work.

Live Roslyn script state, imports, references, helpers, and clients persist across execs and client reconnects while the dotnet-script runtime remains up. Durable exec resources are the authority on whether submitted work ran: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## C# Environment Truth

Inspect the selected REPL instead of guessing about assemblies, source resolution, or API shape:

- `Environment.Version`, `Environment.OSVersion`, and `Directory.GetCurrentDirectory()`;
- `typeof(SomeType).Assembly.Location` for the loaded assembly authority;
- `#load` and `#r` with paths established from the session working directory;
- local source, generated models, examples, and runtime configuration.

Prefer direct .NET APIs over shelling out when an equivalent API exists. Keep secrets in live session state when needed, never in repo files or checkpoints.

## REPL Runtime Notes

- Interactive standard input is unavailable, so provide input through source literals, files, environment variables, or another noninteractive interface.
- C# submissions run as persistent Roslyn script state with top-level asynchronous code, captured `Console` output, and REPL-style rendering of a final non-null value.
- Common namespaces including `System`, collections, IO, LINQ, reflection, text, JSON, and tasks are already in scope, and cwd-relative script references are supported.
- For notebook-style multiline submissions, bayma may retry compilation after inserting semicolons at recognized statement boundaries, but ordinary C# meaning still governs ambiguous code.
- When checkpointed recovery is active, bayma restores only JSON-serializable state written with `bayma_write_checkpoint(value)` across runtime replacement or server restart and makes it available through `bayma_read_checkpoint<T>()`, rather than reconstructing the complete Roslyn script state.

# C# Toolbelt

bayma bundles a toolbelt of pinned Roslyn assemblies, referenced by path as ordinary assemblies with no namespace of the toolbelt's own, that C# sessions can use. They are optional: use them when they help, and leave them aside when they don't. The toolbelt itself, its code, lockfiles, and installed packages, lives in `~/.local/share/bayma/toolbelt` (under `$XDG_DATA_HOME/bayma/toolbelt` when that is set), where bayma installs it with its runtimes; if it is missing, `npx @bayma-repl/bayma doctor` installs it. The listing below shows where their source, types, and documentation live, so code written against them, or executed interactively with them, is correct.

The assemblies and XML documentation behind C# source and type inspection are under:

```text
<toolbelt>   = ~/.local/share/bayma/toolbelt
<assemblies> = <toolbelt>/dotnet

Microsoft.CodeAnalysis                     <assemblies>/Microsoft.CodeAnalysis.dll and .xml
Microsoft.CodeAnalysis.CSharp              <assemblies>/Microsoft.CodeAnalysis.CSharp.dll and .xml
Microsoft.CodeAnalysis.Workspaces          <assemblies>/Microsoft.CodeAnalysis.Workspaces.dll and .xml
Microsoft.CodeAnalysis.CSharp.Workspaces   <assemblies>/Microsoft.CodeAnalysis.CSharp.Workspaces.dll and .xml
Microsoft.CodeAnalysis.Workspaces.MSBuild  <assemblies>/Microsoft.CodeAnalysis.Workspaces.MSBuild.dll and .xml
etc.
```

`<assemblies>/Toolbelt.csproj` and its `packages.lock.json` are the package set's authority. Its Roslyn is the one bayma's C# sessions already run cells on, so its compiler assemblies resolve to those the session has loaded.

## Interactive Quickstart

In a bayma C# session, reference the toolbelt's assemblies in the cell that first succeeds with them, since a cell that fails is rolled back with its references, and spell `<toolbelt>` out as an absolute path, since `#r` does not expand `~`:

```csharp
#r "<toolbelt>/dotnet/Microsoft.CodeAnalysis.dll"
#r "<toolbelt>/dotnet/Microsoft.CodeAnalysis.CSharp.dll"
#r "<toolbelt>/dotnet/Microsoft.CodeAnalysis.Workspaces.dll"
#r "<toolbelt>/dotnet/Microsoft.CodeAnalysis.CSharp.Workspaces.dll"
#r "<toolbelt>/dotnet/Microsoft.CodeAnalysis.Workspaces.MSBuild.dll"
```

You then have access to the tools the quickstart loads.

These tools can be used together in the same REPL to adeptly discover, inspect, parse, search, create, patch, rewrite, copy, move, rename, change permissions, safely remove, and otherwise work with whatever you would like.

An available package API can often do the same thing more directly, clearly, and reliably in the REPL than Bash, terminal commands, or spawned processes.

## Repository Operations

The toolbelt carries no Git library for C#. Commits, merges, and pushes should run a repository's own Git hooks, so run repository operations, inspection and staging among them, on real Git: the `git` executable, started through `System.Diagnostics.Process`, which honors the repository's configuration and hooks.

## Source And Type Inspection

Source and type inspection serves two main purposes: understanding a codebase's source and APIs directly, and discovering how to accomplish work through the toolbelt without falling back to Bash, terminal commands, or spawned processes. The latter is especially important: for most discovering, inspecting, parsing, searching, creating, patching, rewriting, copying, moving, renaming, and so forth, there exists a programmatic toolbelt package or library that models the task more directly, clearly, reliably, and composably. Use the language-appropriate tools and frameworks below in the bayma session for both purposes—to inspect the code you are working on and to understand and use the available package APIs effectively.

Use Roslyn, the C# compiler's own API, for source and package API structure, semantics, and navigation. Load its assemblies as the quickstart does.

Open a project or solution as its build sees it through `MSBuildWorkspace`, created over Roslyn's parts by name, since a script cannot let Roslyn discover them: `MSBuildWorkspace.Create(MefHostServices.Create(new[] { typeof(Workspace).Assembly, typeof(CSharpFormattingOptions).Assembly, typeof(MSBuildWorkspace).Assembly }))`, then `OpenProjectAsync()` or `OpenSolutionAsync()`. Work with `Solution`, `Project`, `Document`, `Compilation`, `SyntaxTree`, `SemanticModel`, `ISymbol`, `INamespaceSymbol`, `INamedTypeSymbol`, `IMethodSymbol`, `IPropertySymbol`, `IFieldSymbol`, `ITypeSymbol`, `IAssemblySymbol`, etc.; follow them through operations such as `project.GetCompilationAsync()`, `compilation.GetTypeByMetadataName()`, `compilation.GetSemanticModel()`, `model.GetDeclaredSymbol()`, `model.GetSymbolInfo()`, `model.GetTypeInfo()`, `symbol.GetMembers()`, `type.BaseType`, `type.AllInterfaces`, `symbol.GetDocumentationCommentXml()`, `symbol.DeclaringSyntaxReferences`, `compilation.GetDiagnostics()`, etc. A package's API is read through the same symbols, from the compilation's metadata references: `compilation.References`, `compilation.GetAssemblyOrModuleSymbol()`, `assembly.GlobalNamespace`, etc.

Navigate with `SymbolFinder.FindReferencesAsync()`, `FindImplementationsAsync()`, `FindDerivedClassesAsync()`, `FindOverridesAsync()`, `FindCallersAsync()`, `FindSourceDeclarationsAsync()`, etc., over `workspace.CurrentSolution`. For objects live in the session, `System.Reflection` is the runtime truth: `GetType()`, `Type.GetMembers()`, `MethodInfo.GetParameters()`, `MemberInfo.GetCustomAttributes()`, etc.

A `Solution` is an immutable snapshot of the workspace, and `MSBuildWorkspace` does not follow edits on disk: keep the workspace across calls, and open the project again after its files change.
