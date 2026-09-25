---
name: bayma-runtime-python
description: Execute Python code interactively in a persistent bayma Python session; create and manage multiple sessions, and use its tools for code, repositories, and source and type inspection.
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

## Reference Materials

bayma's toolbelt gives Python sessions a pinned set of packages, gathered into one `toolbelt` namespace. The toolbelt itself, its code, lockfiles, and installed packages, lives in `~/.local/share/bayma/toolbelt` (under `$XDG_DATA_HOME/bayma/toolbelt` when that is set), where bayma installs it with its runtimes; if it is missing, `npx @bayma-repl/bayma doctor` installs it. This section shows where their source, types, and documentation live, so code written against them, or executed interactively with them, is correct.

The source, type information, and documentation behind the Python `toolbelt` namespace are under:

```text
<toolbelt> = ~/.local/share/bayma/toolbelt
<packages> = <toolbelt>/.venv/lib/python3.12/site-packages

toolbelt.ast_grep           <packages>/ast_grep_py/**
toolbelt.binaryornot        <packages>/binaryornot/**
toolbelt.cachetools         <packages>/cachetools/**
toolbelt.dulwich            <packages>/dulwich/**
toolbelt.dulwich_repo       <packages>/dulwich/repo.py (`Repo` bound to the enclosing repository, or None)
toolbelt.editorconfig       <packages>/editorconfig/**
toolbelt.griffe             <packages>/griffe/**
toolbelt.jedi               <packages>/jedi/**
toolbelt.json5              <packages>/json5/**
toolbelt.libcst             <packages>/libcst/**
toolbelt.markdown_it        <packages>/markdown_it/**
toolbelt.more_itertools     <packages>/more_itertools/**
toolbelt.packaging          <packages>/packaging/**
toolbelt.pathspec           <packages>/pathspec/**
toolbelt.ruamel_yaml        <packages>/ruamel/yaml/**
toolbelt.tomlkit            <packages>/tomlkit/**
toolbelt.wcmatch            <packages>/wcmatch/**
toolbelt.pygls              <packages>/pygls/**
toolbelt.watchfiles         <packages>/watchfiles/**
toolbelt.pytest             <packages>/pytest/**
toolbelt.pytest_asyncio     <packages>/pytest_asyncio/**
toolbelt.basedpyright       <toolbelt>/.venv/bin/basedpyright
toolbelt.ripgrep            <toolbelt>/.venv/bin/rg
toolbelt.ruff               <toolbelt>/.venv/bin/ruff
```

The Python helper that activates the toolbelt's exact environment and assembles this namespace is `<toolbelt>/bayma_toolbelt.py`. The toolbelt environment installs that module from its local source so isolated child processes can import the same helper without inheriting REPL-only path state.

Start the toolbelt's executables, such as `toolbelt.basedpyright`, through `run_bounded_command` in `<toolbelt>/bayma_toolbelt_process.py`: it bounds their time and output, and drops `PYTHONHOME` and `PYTHONPATH` so each child interpreter starts from its own environment whatever the REPL's own interpreter was started with.

Package-backed `toolbelt.*` surfaces expose ordinary modules and clients. The namespace additionally exposes a genuine Dulwich `Repo` bound to the enclosing repository, and bounded helpers for atomic writes, package-root discovery, isolated pytest and Ruff execution, project-owned uv execution, and focused in-process `unittest` execution.

## Interactive Quickstart

In a bayma Python session:

```python
from pathlib import Path
import os
import sys

toolbelt_root = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share") / "bayma/toolbelt"
if str(toolbelt_root) not in sys.path:
    sys.path.insert(0, str(toolbelt_root))

from bayma_toolbelt import open_toolbelt

toolbelt_state = open_toolbelt(cwd=Path.cwd())
globals().update(toolbelt_state)
{
    "repo_root": None if repo_root is None else str(repo_root),
    "python": sys.version.split()[0],
    "packages": len(toolbelt.versions),
}
```

`repo_root` is the Git repository containing the working directory, or `None` outside one, in which case `toolbelt.dulwich_repo` is `None`.

You then have access to the tools the quickstart loads.

These tools can be used together in the same REPL to adeptly discover, inspect, parse, search, create, patch, rewrite, copy, move, rename, change permissions, safely remove, and otherwise work with whatever you would like.

Avoid Bash, terminal commands, and spawned processes when an available package API models the work more directly, clearly, and reliably in the REPL.

## Repository Operations

Use the ordinary Git libraries below for repository inspection and staging. Commits, merges, and pushes should run a repository's own Git hooks; the libraries differ in whether they do, so the choice below keeps those operations on real Git.

Prefer the ordinary Dulwich package through `toolbelt.dulwich` and the repository-bound genuine `dulwich.repo.Repo` at `toolbelt.dulwich_repo` for ordinary repository work. Typical uses include inspection, object traversal, status, index access, staging, etc.

```python
status = toolbelt.dulwich.porcelain.status(toolbelt.dulwich_repo)
head = toolbelt.dulwich_repo[toolbelt.dulwich_repo.head()]
recent_commits = [
    entry.commit
    for entry in toolbelt.dulwich_repo.get_walker(max_entries=10)
]
index = toolbelt.dulwich_repo.open_index()
toolbelt.dulwich.porcelain.add(
    toolbelt.dulwich_repo,
    paths=["path/to/changed-file.py"],
)
```

Commit, merge, and push with the `git` executable, for example through `run_bounded_command` in `<toolbelt>/bayma_toolbelt_process.py`. Avoid `toolbelt.dulwich.porcelain.commit()` and `toolbelt.dulwich.porcelain.push()` in a repository with hooks: the pinned Dulwich commit path does not honor a configured `core.hooksPath`, and its push path does not execute the pre-push hook.

## Source And Type Inspection

Source and type inspection serves two main purposes: understanding a codebase's source and APIs directly, and discovering how to accomplish work through the toolbelt without falling back to Bash, terminal commands, or spawned processes. The latter is especially important: for most discovering, inspecting, parsing, searching, creating, patching, rewriting, copying, moving, renaming, and so forth, there exists a programmatic toolbelt package or library that models the task more directly, clearly, reliably, and composably. Use the language-appropriate tools and frameworks below in the bayma session for both purposes—to inspect the code you are working on and to understand and use the available package APIs effectively.

Use Griffe through `toolbelt.griffe` for static package and API structure, Jedi through `toolbelt.jedi` for semantic code intelligence, and `inspect` plus `importlib` when live runtime truth is required. Work with Griffe exports such as `toolbelt.griffe.GriffeLoader`, `toolbelt.griffe.Module`, `toolbelt.griffe.Class`, `toolbelt.griffe.Function`, `toolbelt.griffe.Attribute`, `toolbelt.griffe.Alias`, `toolbelt.griffe.ObjectKind`, `toolbelt.griffe.Docstring`, etc.; load modules through `toolbelt.griffe.load()` or `loader.load()`, inspect `module.members`, `object.all_members`, `class.inherited_members`, `function.parameters`, `function.returns`, `object.annotation`, `object.docstring`, `object.source`, `object.filepath`, `object.lineno`, `object.endlineno`, etc., and resolve aliases through `loader.resolve_aliases()`.

Use `toolbelt.jedi.Project`, `toolbelt.jedi.Script`, `toolbelt.jedi.Interpreter`, etc., with operations such as `get_names()`, `infer()`, `goto()`, `get_references()`, `get_signatures()`, `complete()`, `search()`, etc. Inspect the returned names, definitions, signatures, parameters, completions, etc., through properties such as `name`, `type`, `full_name`, `module_path`, `line`, `column`, `description`, `params`, etc. For imported runtime objects, use `inspect.getmembers()`, `inspect.signature()`, `inspect.getsource()`, `inspect.getsourcelines()`, `inspect.get_annotations()`, `inspect.unwrap()`, etc., together with `importlib.import_module()`, `importlib.util.find_spec()`, `importlib.metadata`, etc.
