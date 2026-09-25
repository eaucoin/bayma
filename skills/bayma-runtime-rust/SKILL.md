---
name: bayma-runtime-rust
description: Execute Rust code interactively in a persistent bayma EVcxR session; create and manage multiple sessions.
---

# Rust Runtime

Use bayma's Rust runtime when executable memory will improve the work. A session is an interactive workbench: items, imports, variables, dependencies, datasets, intermediate results, helpers, and evolving program state can remain available while you write, compile, execute, inspect results, and revise.

The goal is not merely to run Rust code. It is to avoid repeatedly reconstructing the same context and to support a coherent body of interactive work over time.

If you are reading this skill, make sure that you can see all of bayma's tools loaded among your other tools, under whatever prefix your client gives them, such as `mcp__bayma__session_create`:

- `exec`
- `wait`
- `session.acquire_controller`
- `session.close`
- `session.create`
- `session.interrupt`
- `session.release_controller`
- `session.resize`

Create sessions with `runtime: "rust"`; the selected runtime remains fixed for the session lifetime. Do not build throwaway Cargo projects or one-off Rust executions instead of using bayma.

## Choose The Workbench

- Continue in the current session when the next step belongs to the same body of work and its accumulated EVcxR state is still useful.
- After a restart, interruption, or genuine change of task, inspect `bayma:///sessions` and recover the Rust workbench that best preserves the relevant context.
- Reuse based on continuity of work: the same objective, `cwd`, dependency set, data, owned values, intermediate state, and intended output. A matching `cwd` is necessary for local dependency resolution, but it is not by itself a reason to combine unrelated work.
- Create a new session for clean-room validation, a different checkout, incompatible or misleading ownership state, or truly independent concurrent work.
- Do not create a separate session merely because another crate or domain becomes involved. One session can accumulate several cooperating dependencies and values when that makes the ongoing work easier to continue.

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the work meaningfully changes.

## Work Interactively

Use short cells to perform the next meaningful step. Review the resulting state, then write or execute the next cell. Prefer several legible cells over a giant program that performs the entire workflow without an opportunity to adapt.

Important: when deriving a REPL output, transform the value into a representation that removes repeated structure, factors shared structure into common parents, and omits values that can be derived from other values already present. Preserve enough information to reconstruct the original value, then choose the valid serialized form that makes the REPL output shortest.

Retain state that will make later reasoning cheaper or more precise:

- imports, items, dependency declarations, and initialized clients;
- owned datasets, indexes, and query results;
- intermediate calculations and comparison baselines;
- transformations that are being refined;
- discovered capabilities, constraints, and reusable helpers.

Give retained values descriptive domain names. Do not initialize generic caches, notes collections, or REPL scaffolding merely to prove the session is persistent.

Persistent memory does not make facts timeless. Refresh external observations when freshness matters, and replace state that has become stale, ambiguous, moved, or invalid.

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

Live EVcxR items, imports, dependencies, and owned values persist across execs and client reconnects while the Rust host remains up. An interrupt recycles the Rust host rather than claiming soft continuity; only the last committed checkpoint hydrates the replacement. Durable exec resources are the authority on whether submitted work compiled and ran: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## Rust Environment Truth

Inspect the selected REPL instead of guessing about dependencies, paths, or compiler behavior:

- `std::env::current_dir()` and relevant environment variables;
- small type, ownership, and final-expression probes;
- `:dep` declarations for the exact dependencies the work requires;
- local crate source, generated models, examples, and runtime configuration.

Use ordinary Rust and Cargo semantics within bayma's declared boundaries. Keep secrets in live session state when needed, never in repo files or checkpoints.

## REPL Runtime Notes

- Interactive standard input is unavailable, so provide input through source literals, files, environment variables, or another noninteractive interface.
- Rust submissions execute in a persistent EVcxR context where items, imports, mutable variables, dependencies, and top-level `.await` can persist, and final values use EVcxR's `text/plain` display.
- Normal ownership rules remain in force, so moved values cannot be reused and references into variables created by earlier calls are not supported as persistent state; prefer owned values across calls.
- Add dependencies with `:dep crate = "version"`; registry and Git specifications retain Cargo behavior, relative path dependencies resolve from the session working directory, and bayma uses a separate generated manifest without modifying the project manifest. `:lockfile path/to/Cargo.lock` resolves them against that lockfile, keeping its versions, yanked ones included, and `:lockfile` alone stops.
- bayma supplies the compiler and build authority, so EVcxR commands cannot replace the toolchain, linker, compiler wrappers, protected environment, or startup configuration.
- Compiler failures, caught panics, and an early return through `?` are reported through the execution channels, while an unsafe abort or fatal signal can destroy the evaluation child.
- When checkpointed recovery is active, checkpoint values must support serde and are written with `bayma_rust_support::write_checkpoint(&mut bayma_checkpoint, &value)` and read with `bayma_rust_support::read_checkpoint(&bayma_checkpoint)`.
- Recovery restores only the last committed checkpoint, never replays earlier calls or their side effects, and discards non-checkpointed live state when the execution child is replaced or the session is interrupted.
- Threads and child processes must finish before the call returns because detached writers cannot retain causal output attribution and work that outlives its call is unsupported.
