---
name: bayma-runtime-python
description: Execute Python code interactively in a persistent bayma Python session; create and manage multiple sessions.
---

# Python Runtime

Use bayma's Python runtime when executable memory will improve the work. A session is an interactive workbench: imports, clients, objects, datasets, transformations, intermediate results, helpers, and evolving program state can remain available while you write, execute, inspect results, and revise.

The goal is not merely to run Python code. It is to avoid repeatedly reconstructing the same context and to support a coherent body of interactive work over time.

If you are reading this skill, make sure that you can see all of bayma's tools loaded among your other tools, under whatever prefix your client gives them, such as `mcp__bayma__session_create`:

- `exec`
- `wait`
- `session.acquire_controller`
- `session.close`
- `session.create`
- `session.interrupt`
- `session.release_controller`
- `session.resize`

Create sessions with `runtime: "python"`; the selected runtime remains fixed for the session lifetime. Do not run Python heredocs, `python -c` snippets, or one-off Python executions instead of using bayma.

## Choose The Workbench

- Continue in the current session when the next step belongs to the same body of work and its accumulated state is still useful.
- After a restart, interruption, or genuine change of task, inspect `bayma:///sessions` and recover the Python workbench that best preserves the relevant context.
- Reuse based on continuity of work: the same objective, environment, credentials, data, objects, intermediate state, and intended output. Compatible `cwd`, interpreter, and `sys.path` are necessary, but they are not by themselves reasons to combine unrelated work.
- Create a new session for clean-room validation, a different checkout, incompatible or misleading state, or truly independent concurrent work.
- Do not create a separate session merely because another Python package or domain becomes involved. One session can accumulate several cooperating objects when that makes the ongoing work easier to continue.

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the work meaningfully changes.

## Work Interactively

Use short cells to perform the next meaningful step. Review the resulting state, then write or execute the next cell. Prefer several legible cells over a giant script that performs the entire workflow without an opportunity to adapt.

Important: when deriving a REPL output, transform the value into a representation that removes repeated structure, factors shared structure into common parents, and omits values that can be derived from other values already present. Preserve enough information to reconstruct the original value, then choose the valid serialized form that makes the REPL output shortest.

Retain state that will make later reasoning cheaper or more precise:

- imported modules and initialized clients;
- parsed dataframes, arrays, indexes, and query results;
- intermediate calculations and comparison baselines;
- transformations that are being refined;
- discovered capabilities, constraints, and reusable helpers.

Give retained objects descriptive domain names. Do not initialize generic caches, notes dictionaries, or REPL scaffolding merely to prove the session is persistent.

Persistent memory does not make facts timeless. Refresh external observations when freshness matters, and replace state that has become stale, ambiguous, or invalid.

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

Live globals, imports, helpers, and objects persist across execs and client reconnects while the Python runtime remains up. Durable exec resources are the authority on whether submitted work ran: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## Python Environment Truth

Inspect the selected REPL instead of guessing about package availability or API shape:

- `sys.executable`, `sys.version`, `sys.path`, and `site`;
- `importlib.util.find_spec(...)` for resolved import paths;
- `importlib.metadata` for installed distribution names and versions, remembering that a distribution's name and its import name often differ;
- resolved module source, type stubs, and project-local Python files.

Prefer direct Python APIs over shelling out when an equivalent API exists. The session runs bayma's own interpreter, so do not assume the host's `pip`, virtualenv state, or package installation applies to it; if a package is missing, say so rather than installing into the live session. Keep secrets in live session state when needed, never in repo files or checkpoints.

## REPL Runtime Notes

- Interactive standard input is unavailable, so provide input through source literals, files, environment variables, or another noninteractive interface.
- Python globals and imports persist across calls, the session working directory is placed on `sys.path` for local imports, and packages available to the selected interpreter can be imported.
- A final expression is rendered and saved in `_`, exceptions are saved in `_error`, and top-level `await` is accepted.
- A top-level asynchronous submission runs through a fresh `asyncio.run` invocation, so tasks created there must finish during that call rather than being treated as persistent background work.
- `sys.stdout` and `sys.stderr` are UTF-8 non-TTY proxies supporting `write`, `flush`, `writable`, `isatty`, `encoding`, `errors`, and a writable binary buffer, but they are not general terminal or file objects.
- When checkpointed recovery is active, bayma restores only the pickle-compatible value written with `bayma_write_checkpoint(...)` across runtime replacement or server restart, makes it available through `bayma_read_checkpoint()`, and does not replay live globals or earlier side effects.
