---
name: bayma-runtime-go
description: Execute Go code interactively in a persistent bayma Go session; create and manage multiple sessions.
---

# Go Runtime

Use bayma's Go runtime when executable memory will improve the work. A session is an interactive workbench: imports, types, functions, variables, clients, datasets, intermediate results, helpers, and evolving program state can remain available while you write, compile, execute, inspect results, and revise.

The goal is not merely to run Go code. It is to avoid repeatedly reconstructing the same context and to support a coherent body of interactive work over time.

If you are reading this skill, make sure that you can see all of bayma's tools loaded among your other tools, under whatever prefix your client gives them, such as `mcp__bayma__session_create`:

- `exec`
- `wait`
- `session.acquire_controller`
- `session.close`
- `session.create`
- `session.interrupt`
- `session.release_controller`
- `session.resize`

Create sessions with `runtime: "go"`; the selected runtime remains fixed for the session lifetime. Do not write throwaway `main` packages or one-off `go run` executions instead of using bayma.

## Choose The Workbench

- Continue in the current session when the next step belongs to the same body of work and its accumulated package state is still useful.
- After a restart, interruption, or genuine change of task, inspect `bayma:///sessions` and recover the Go workbench that best preserves the relevant context.
- Reuse based on continuity of work: the same objective, `cwd`, module versions, data, clients, intermediate state, and intended output. A matching `cwd` is necessary for the working directory's module, but it is not by itself a reason to combine unrelated work.
- Create a new session for clean-room validation, a different checkout, a module version other than the one already loaded, incompatible or misleading state, or truly independent concurrent work.
- Do not create a separate session merely because another module or domain becomes involved. One session can accumulate several cooperating clients and values when that makes the ongoing work easier to continue.

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the work meaningfully changes.

## Work Interactively

Use short cells to perform the next meaningful step. Review the resulting state, then write or execute the next cell. Prefer several legible cells over a giant program that performs the entire workflow without an opportunity to adapt.

Important: when deriving a REPL output, transform the value into a representation that removes repeated structure, factors shared structure into common parents, and omits values that can be derived from other values already present. Preserve enough information to reconstruct the original value, then choose the valid serialized form that makes the REPL output shortest.

Retain state that will make later reasoning cheaper or more precise:

- imports, types, and initialized clients;
- parsed datasets, indexes, and query results;
- intermediate calculations and comparison baselines;
- functions that are being refined;
- discovered capabilities, constraints, and reusable helpers.

Give retained state descriptive domain names. Do not initialize generic caches, notes collections, or REPL scaffolding merely to prove the session is persistent.

Persistent memory does not make facts timeless. Refresh external observations when freshness matters, and replace state that has become stale, ambiguous, or invalid.

## Continue Safely

- If an exec is still running, continue it with `wait`; do not duplicate compilation or execution.
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

Everything the session declared persists across execs and client reconnects while the Go host remains up. An interrupt restarts the host; only the last committed checkpoint carries over. A panic in a goroutine a cell started ends the host and quarantines the session. Durable exec resources are the authority on whether submitted work compiled and ran: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## Go Environment Truth

Inspect the selected REPL instead of guessing about modules, versions, or API shape:

- `go.mod` and `go.sum` in the session working directory, whose module a cell imports by its module path;
- `runtime.Version()`, `os.Getwd()`, and relevant environment variables;
- `go list -m all` or `go doc`, run from the session working directory with the `go` on the session's `PATH`;
- module source in the module cache, and local source, generated code, and examples.

Modules come through the Go module proxy, and a module's version is fixed once the session has loaded it. Keep secrets in live session state when needed, never in repo files or checkpoints.

## REPL Runtime Notes

- Interactive standard input is unavailable, so provide input through source literals, files, environment variables, or another noninteractive interface.
- A session is one package that grows a cell at a time, in a process that stays alive: each cell may hold imports, then declarations and statements in any order, and its statements run once.
- Everything a cell declares, unexported names, fields, and methods included, stays live for later cells, while a name declared again replaces the old one.
- A cell ending in a single expression returns its value, or every value of a call that returns several; end in a struct or slice to see several of your own.
- The first session on a machine compiles Go's standard library for its cells, once, so it starts slowly.
- Goroutines a cell starts keep running, but output written while no cell runs is dropped, and a panic that escapes one ends the host and quarantines the session: recover inside the goroutines a cell starts.
- When checkpointed recovery is active, bayma preserves only the JSON-compatible value written with `bayma_write_checkpoint(value)`, read back with `bayma_read_checkpoint(&value)`, and never replays earlier calls or their side effects.
