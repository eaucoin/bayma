---
name: bayma-runtime-c
description: Execute C code interactively in a persistent bayma clang-repl session; create and manage multiple sessions.
---

# C Runtime

Use bayma's C runtime when executable memory will improve the work. A session is an interactive workbench: definitions, variables, included headers, loaded libraries, datasets, intermediate results, helpers, and evolving program state can remain available while you write, compile, execute, inspect results, and revise.

The goal is not merely to run C code. It is to avoid repeatedly reconstructing the same context and to support a coherent body of interactive work over time.

If you are reading this skill, make sure that you can see all of bayma's tools loaded among your other tools, under whatever prefix your client gives them, such as `mcp__bayma__session_create`:

- `exec`
- `wait`
- `session.acquire_controller`
- `session.close`
- `session.create`
- `session.interrupt`
- `session.release_controller`
- `session.resize`

Create sessions with `runtime: "c"`; the selected runtime remains fixed for the session lifetime. Do not compile throwaway programs or one-off C executions instead of using bayma.

## Choose The Workbench

- Continue in the current session when the next step belongs to the same body of work and its accumulated interpreter state is still useful.
- After a restart, interruption, or genuine change of task, inspect `bayma:///sessions` and recover the C workbench that best preserves the relevant context.
- Reuse based on continuity of work: the same objective, `cwd`, compiler arguments, libraries, data, intermediate state, and intended output. A matching `cwd` is necessary for header and library resolution, but it is not by itself a reason to combine unrelated work.
- Create a new session for clean-room validation, a different checkout or `compile_flags.txt`, incompatible or misleading state, or truly independent concurrent work.
- Do not create a separate session merely because another header or domain becomes involved. One session can accumulate several cooperating libraries and objects when that makes the ongoing work easier to continue.

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the work meaningfully changes.

## Work Interactively

Use short cells to perform the next meaningful step. Review the resulting state, then write or execute the next cell. Prefer several legible cells over a giant program that performs the entire workflow without an opportunity to adapt.

Important: when deriving a REPL output, transform the value into a representation that removes repeated structure, factors shared structure into common parents, and omits values that can be derived from other values already present. Preserve enough information to reconstruct the original value, then choose the valid serialized form that makes the REPL output shortest.

Retain state that will make later reasoning cheaper or more precise:

- included headers, loaded libraries, and initialized handles;
- parsed datasets, indexes, and query results;
- intermediate calculations and comparison baselines;
- functions and types that are being refined;
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

Live definitions, variables, headers, and libraries persist across execs and client reconnects while the interpreter remains up. A crash, exit, or interrupt replaces the interpreter; only the last committed checkpoint carries over. Durable exec resources are the authority on whether submitted work compiled and ran: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## C Environment Truth

Inspect the selected REPL instead of guessing about headers, libraries, or compiler behavior:

- `compile_flags.txt` in the session working directory, one argument per line as clangd reads it, which sets the compiler's arguments (such as `-I`, `-isystem`, `-D`, and `-std=`) and loads libraries (`-L` and `-l`, or a library's path);
- `__STDC_VERSION__` and `__clang_version__` for the language in use;
- `getcwd` and relevant environment variables;
- local headers, sources, libraries, and build configuration.

Quoted `#include` paths resolve from the session working directory. Keep secrets in live session state when needed, never in repo files or checkpoints.

## REPL Runtime Notes

- Interactive standard input is unavailable, so provide input through source literals, files, environment variables, or another noninteractive interface.
- Clang's incremental Interpreter (clang-repl) compiles each exec and runs it in the session's process. Sessions are C23, or another standard with `-std=`.
- Cells share what loaded libraries define, as a linked program would.
- A trailing expression without a semicolon is the exec's result.
- An exec that fails to compile or link is undone entirely, the headers it included among them, which the next cell to use them must include again.
- If an exec crashes the process or exits, the exec ends with an error and the session continues in a fresh interpreter, keeping its checkpoint but losing its definitions and values; an interrupt does the same.
- Output written by threads after an exec returns is discarded, so join threads before a cell returns.
- When checkpointed recovery is active, bayma preserves only JSON text written with `bayma_write_checkpoint(json)` and read with `bayma_read_checkpoint()`, and never replays earlier calls or their side effects.
