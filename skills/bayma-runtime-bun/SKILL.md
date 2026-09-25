---
name: bayma-runtime-bun
description: Execute JavaScript or TypeScript code interactively in a persistent bayma Bun session; create and manage multiple sessions.
---

# Bun Runtime

Use bayma's Bun runtime when executable memory will improve the work. A session is an interactive workbench: imports, clients, browser handles, datasets, intermediate results, helpers, and evolving program state can remain available while you write, execute, inspect results, and revise.

The goal is not merely to run Bun code. It is to avoid repeatedly reconstructing the same context and to support a coherent body of interactive work over time.

If you are reading this skill, make sure that you can see all of bayma's tools loaded among your other tools, under whatever prefix your client gives them, such as `mcp__bayma__session_create`:

- `exec`
- `wait`
- `session.acquire_controller`
- `session.close`
- `session.create`
- `session.interrupt`
- `session.release_controller`
- `session.resize`

Create sessions with `runtime: "bun"`; the selected runtime remains fixed for the session lifetime. Do not run Bun heredocs or one-off Bun executions instead of using bayma.

## Choose The Workbench

- Continue in the current session when the next step belongs to the same body of work and its accumulated state is still useful.
- After a restart, interruption, or genuine change of task, inspect `bayma:///sessions` and recover the Bun workbench that best preserves the relevant context.
- Reuse based on continuity of work: the same objective, `cwd`, credentials, data, clients, intermediate state, and intended output. A matching `cwd` is necessary for package and source resolution, but it is not by itself a reason to combine unrelated work.
- Create a new session for clean-room validation, a different checkout or identity, incompatible or misleading state, or truly independent concurrent work.
- Do not create a separate session merely because another package or platform skill becomes involved. One session can accumulate several cooperating clients when that makes the ongoing work easier to continue.

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the work meaningfully changes.

## Work Interactively

Use short execs to perform the next meaningful step. Review the resulting state, then write or execute the next cell. Prefer several legible cells over a giant script that performs the entire workflow without an opportunity to adapt.

Important: when deriving a REPL output, transform the value into a representation that removes repeated structure, factors shared structure into common parents, and omits values that can be derived from other values already present. Preserve enough information to reconstruct the original value, then choose the valid serialized form that makes the REPL output shortest.

Retain state that will make later reasoning cheaper or more precise:

- initialized SDK or API clients;
- browser pages and handles;
- parsed datasets, indexes, cursors, and query results;
- intermediate calculations and comparison baselines;
- discovered capabilities, constraints, and reusable helpers.

Give retained state domain names such as `globalThis.prAudit`, `globalThis.billingClient`, or `globalThis.releaseEvidence`. Do not initialize generic caches, notes arrays, or REPL scaffolding merely to prove the session is persistent.

Persistent memory does not make facts timeless. Refresh remote observations when freshness matters, and replace state that has become stale, ambiguous, or invalid.

## Continue Safely

- If an exec is still running, continue it with `wait`; do not duplicate the work.
- After a disconnect or uncertain tool result, inspect the durable session and exec records before resubmitting code.
- Reacquire the known workbench after interruption when its context remains useful.
- Inspect controller ownership, queue state, recovery, or quarantine details only when an actual coordination or lifecycle issue requires it.
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

Live globals, imports, helpers, and clients persist across execs and client reconnects while the Bun runtime remains up. Durable exec resources are the authority on whether submitted work ran: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## Bun Environment Truth

Inspect the actual environment reachable from the selected `cwd` instead of guessing:

- `package.json`, lockfiles, and `tsconfig.json`;
- installed package source and types under `node_modules/**`;
- local source, generated models, examples, and runtime configuration;
- `require.resolve(...)`, `Bun.resolveSync(...)`, or a minimal import probe.

If imports fail, the session may simply be pointed at the wrong package tree; the installed package version may not match your memory either. Keep secrets in live session state when needed, never in repo files or checkpoints.

## REPL Runtime Notes

- Interactive standard input is unavailable, so provide input through source literals, files, environment variables, or another noninteractive interface.
- Bun sessions run JavaScript or TypeScript with live bindings across calls and expose `Bun.*`, `fetch`, top-level `await`, dynamic imports, `require`, `module`, `__filename`, `__dirname`, and packages resolved from the session working directory.
- A non-`undefined` final value is returned as result text and stored in `_`, while a thrown value is stored in `_error`; console and value rendering are bounded, so very large or unsafe-to-inspect values may be abbreviated.
- When checkpointed recovery is active, bayma restores only `$checkpoint` across runtime replacement or server restart using its structured-clone codec and never replays earlier calls or their side effects.
