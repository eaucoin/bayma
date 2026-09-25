---
name: bayma-runtime-lean
description: Execute Lean 4 commands interactively in a persistent bayma Lean session; create and manage multiple sessions, and use its tools for code, repositories, and source and type inspection.
---

# Lean Runtime

Use bayma's Lean runtime when executable memory will improve the work. A session is an interactive workbench: imports, definitions, theorems, instances, attributes, open namespaces, options, and evolving developments can remain available while you write, elaborate, inspect results, and revise.

The goal is not merely to run Lean commands. It is to avoid repeatedly reconstructing the same context and to support a coherent body of interactive work over time.

If you are reading this skill, make sure that you can see all of bayma's tools loaded among your other tools, under whatever prefix your client gives them, such as `mcp__bayma__session_create`:

- `exec`
- `wait`
- `session.acquire_controller`
- `session.close`
- `session.create`
- `session.interrupt`
- `session.release_controller`
- `session.resize`

Create sessions with `runtime: "lean"`; the selected runtime remains fixed for the session lifetime. Do not write throwaway `.lean` files or one-off `lean` executions instead of using bayma.

## Choose The Workbench

- Continue in the current session when the next step belongs to the same body of work and its accumulated environment is still useful.
- After a restart, interruption, or genuine change of task, inspect `bayma:///sessions` and recover the Lean workbench that best preserves the relevant context.
- Reuse based on continuity of work: the same objective, `cwd`, imports, definitions, lemmas, open namespaces, and intended output. A matching `cwd` is necessary for the Lake project's libraries, but it is not by itself a reason to combine unrelated work.
- Create a new session for clean-room validation, a different checkout or set of imports, incompatible or misleading declarations, or truly independent concurrent work.
- Do not create a separate session merely because another library or domain becomes involved, unless it must be imported: imports belong in a session's first cell.

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the work meaningfully changes.

## Work Interactively

Use short cells to perform the next meaningful step. Review the resulting state, then write or execute the next cell. Prefer several legible cells over a giant file that elaborates the entire development without an opportunity to adapt.

Important: when deriving a REPL output, transform the value into a representation that removes repeated structure, factors shared structure into common parents, and omits values that can be derived from other values already present. Preserve enough information to reconstruct the original value, then choose the valid serialized form that makes the REPL output shortest.

Retain state that will make later reasoning cheaper or more precise:

- definitions, structures, and instances;
- proved lemmas and the `simp` sets they extend;
- open namespaces, sections, variables, and options;
- examples and counterexamples being refined;
- discovered capabilities, constraints, and reusable tactics.

Give declarations descriptive domain names, inside a namespace for the body of work. Do not declare scaffolding merely to prove the session is persistent.

Persistent memory does not make facts timeless. Replace declarations that have become stale, ambiguous, or invalid.

## Continue Safely

- If an exec is still running, continue it with `wait`; do not duplicate the elaboration.
- After a disconnect or uncertain tool result, inspect the durable session and exec records before resubmitting code.
- Reacquire the known workbench after interruption when its context remains useful.
- Inspect controller ownership, queue state, recovery, or quarantine details only when an actual coordination or lifecycle concern requires it.
- Leave a useful workbench available for later continuation. Release control when another actor should use it. Close it only when it is disposable, invalid, or more confusing than reconstructing the work.

## Session Lifecycle

Workbench usefulness remains the primary selection criterion; these states matter when coordination or recovery does.

- `live_idle`: continue when the workbench is relevant; acquire control if unowned.
- `live_busy`: inspect the active and queued execs, then wait or observe rather than duplicating work.
- `suspended`: reacquire and resume when its retained purpose and checkpoint remain useful.
- `recovering`: wait for recovery to settle before deciding what to do next.
- `quarantined`: inspect the reason; replace the session unless the underlying fault is explicitly repaired.
- `closed`, or announced for eviction by a `session/evictionScheduled` event: do not select for new work.

Controller authority is exclusive. Do not steal or close another actor's session. Observe it, wait for release, or create a separate workbench only for genuinely independent work.

The environment persists across execs and client reconnects while the Lean host remains up. An interrupt restarts the host; with checkpointed recovery active, the last committed checkpoint restores it. Durable exec resources are the authority on whether submitted work elaborated: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## Lean Environment Truth

Inspect the selected REPL instead of guessing about libraries, names, or elaboration:

- `lean-toolchain`, `lakefile.toml` or `lakefile.lean`, and `lake-manifest.json` in the session working directory;
- `#eval Lean.versionString` for the Lean in use;
- `#check`, `#print`, `#print axioms`, and `#synth` for what a name means and what it rests on;
- the project's source and its built libraries under `.lake/build`.

A Lake project in the session working directory supplies its libraries, such as Mathlib, once built with the `lake` on the session's `PATH`, whose Lean its `lean-toolchain` must name. If an import fails, the project may be unbuilt, pinned to another Lean, or the session may be pointed at the wrong directory. Keep secrets in live session state when needed, never in repo files or checkpoints.

## REPL Runtime Notes

- Interactive standard input is unavailable, so provide input through source literals, files, environment variables, or another noninteractive interface.
- Each cell runs on the environment the previous cell left, so its definitions, theorems, instances, and attributes stay in scope; imports belong in a session's first cell.
- A cell's last info message, such as a final `#eval`'s value or a `#check`, is its result; its earlier ones, such as what an `#eval` printed, are its stdout.
- Warnings go to stderr and errors to the exec's error, each with its `line:column`; a command that fails leaves the commands after it to run, and the exec ends in error.
- An interrupt restarts the session, since nothing stops Lean's elaborator from outside it.
- When checkpointed recovery is active, bayma restores everything the session declared, with its open namespaces, options, and variables, and never replays earlier calls or their side effects.

## Reference Materials

Lean sessions need nothing from the toolbelt: their tools come with the runtime. This section shows where their source, types, and documentation live, so code written against them, or executed interactively with them, is correct.

Lean's metaprogramming API is Lean's own source, shipped with the Lean the session runs:

```text
<sysroot> = what Lean.findSysroot returns in the session

Lean  <sysroot>/src/lean/Lean/** (Environment.lean, Meta/**, Server/**, etc.)
Init  <sysroot>/src/lean/Init/**
```

## Interactive Quickstart

In a bayma Lean session, import Lean in the session's first cell, where imports belong; there is nothing else to install:

```lean
import Lean
open Lean Meta
```

You then have access to the tools the quickstart loads.

These tools, with the language's own standard library, can be used together in the same REPL to adeptly discover, inspect, parse, search, create, patch, rewrite, copy, move, rename, change permissions, safely remove, and otherwise work with whatever you would like.

Avoid Bash, terminal commands, and spawned processes when an available package API models the work more directly, clearly, and reliably in the REPL.

## Repository Operations

The toolbelt carries no Git library for Lean. Commits, merges, and pushes should run a repository's own Git hooks, so run repository operations, inspection and staging among them, on real Git: the `git` executable, started through `IO.Process.output` or `IO.Process.spawn`, which honors the repository's configuration and hooks.

## Source And Type Inspection

Source and type inspection serves two main purposes: understanding a codebase's source and APIs directly, and discovering how to accomplish work through the toolbelt without falling back to Bash, terminal commands, or spawned processes. The latter is especially important: for most discovering, inspecting, parsing, searching, creating, patching, rewriting, copying, moving, renaming, and so forth, there exists a programmatic toolbelt package or library that models the task more directly, clearly, reliably, and composably. Use the language-appropriate tools and frameworks below in the bayma session for both purposes—to inspect the code you are working on and to understand and use the available package APIs effectively.

Use Lean's own metaprogramming API, which the language server, `#check`, and `#print` are built on, imported as the quickstart does. Work with `Environment`, `ConstantInfo`, `Expr`, `Name`, `DeclarationRanges`, `ModuleIdx`, etc.; follow them through `getEnv`, `env.find?`, `env.contains`, `env.constants`, `env.getModuleIdxFor?`, `env.header.moduleNames`, `ConstantInfo.type`, `ConstantInfo.value?`, `findDocString?`, `findDeclarationRanges?`, `getStructureFields`, `isInstance`, `collectAxioms`, etc., and read types in `MetaM` through `inferType`, `whnf`, `forallTelescope`, `isDefEq`, `ppExpr`, etc., run from a cell with `#eval show MetaM Unit from do …`. `#check`, `#print`, `#print axioms`, and `#synth` answer single questions directly.

For references, read the `.ilean` files Lake writes beside each built module, under a project's `.lake/build/lib/lean/`, and the toolchain's own beside its `.olean`s, with `Lean.Server.Ilean.load`; follow `ilean.references` from each `RefIdent` to its `RefInfo`, whose `definition?` and `usages` locate the name's definition and uses, etc.

What the session itself declares is in its environment but in no `.ilean`: find references among its cells through the environment, and across a project through its built modules, which `lake build` refreshes after its source changes.
