---
name: bayma-runtime-rust
description: Execute Rust code interactively in a persistent bayma EVcxR session; create and manage multiple sessions, and use its tools for code, repositories, and source and type inspection.
---

# Rust Runtime

Use bayma's Rust runtime when executable memory will help. A session is an interactive workbench: items, imports, variables, dependencies, datasets, intermediate results, helpers, and evolving program state can remain available while you write, compile, execute, inspect results, and revise.

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

Use a short, stable title that names the body of work rather than the current prompt. Do not list and inspect every session before every small exec; revisit session choice when continuity is uncertain or the task meaningfully changes.

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

Live EVcxR items, imports, dependencies, and owned values persist across execs and client reconnects while the Rust host remains up. An interrupt recycles the Rust host rather than claiming soft continuity; only the last committed checkpoint hydrates the replacement. Durable exec resources are the authority on whether submitted work compiled and ran: `bayma:///session/{sessionId}/exec/{execId}` for status and code, and `/messages` for ordered output and errors.

## Rust Environment Truth

Inspect the selected REPL instead of guessing about dependencies, paths, or compiler behavior:

- `std::env::current_dir()` and relevant environment variables;
- small type, ownership, and final-expression probes;
- `:dep` declarations for exactly the dependencies needed;
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

# Rust Toolbelt

bayma bundles a toolbelt of pinned crates, declared directly, that Rust sessions can use. They are optional: use them when they help, and leave them aside when they don't. The toolbelt itself, its code, lockfiles, and installed packages, lives in `~/.local/share/bayma/toolbelt` (under `$XDG_DATA_HOME/bayma/toolbelt` when that is set), where bayma installs it with its runtimes; if it is missing, `npx @bayma-repl/bayma doctor` installs it. The listing below shows where their source, types, and documentation live, so code written against them, or executed interactively with them, is correct.

The source, types, and documentation behind the Rust package set are under:

```text
<toolbelt>  = ~/.local/share/bayma/toolbelt
<manifest>  = <toolbelt>/Cargo.toml and <toolbelt>/Cargo.lock
<packages>  = ~/.cache/bayma/rust/cargo-home-1.97.1/registry/src/index.crates.io-*/

ast_grep_core    <packages>/ast-grep-core-0.45.0/**
blake3           <packages>/blake3-1.8.5/**
ec4rs            <packages>/ec4rs-1.2.0/**
encoding_rs      <packages>/encoding_rs-0.8.35/**
gix              <packages>/gix-0.87.1/**
globset          <packages>/globset-0.4.19/**
grep             <packages>/grep-0.4.1/**
ignore           <packages>/ignore-0.4.31/**
imara_diff       <packages>/imara-diff-0.2.0/**
json5            <packages>/json5-1.3.1/**
jsonc_parser     <packages>/jsonc-parser-0.33.1/**
lru              <packages>/lru-0.18.1/**
markdown         <packages>/markdown-1.0.0/**
parking_lot      <packages>/parking_lot-0.12.5/**
ra_ap_base_db    <packages>/ra_ap_base_db-0.0.344/**
ra_ap_cfg        <packages>/ra_ap_cfg-0.0.344/**
ra_ap_hir        <packages>/ra_ap_hir-0.0.344/**
ra_ap_ide        <packages>/ra_ap_ide-0.0.344/**
ra_ap_syntax     <packages>/ra_ap_syntax-0.0.344/**
rayon            <packages>/rayon-1.12.0/**
roxmltree        <packages>/roxmltree-0.21.1/**
saphyr           <packages>/saphyr-0.0.11/**
serde            <packages>/serde-1.0.228/**
serde_json       <packages>/serde_json-1.0.145/**
tempfile         <packages>/tempfile-3.26.0/**
thiserror        <packages>/thiserror-2.0.19/**
toml_edit        <packages>/toml_edit-0.25.13+spec-1.1.0/**
wait_timeout     <packages>/wait-timeout-0.2.1/**
yaml_edit        <packages>/yaml-edit-0.2.3/**
etc.
```

Declare the exact packages needed with ordinary EVcxR `:dep` directives using the versions and feature sets in `<manifest>`, then use each crate's native types, traits, functions, and documentation directly. `<manifest>` is the package-set authority and deliberately exports no replacement API; the packages are never re-exported behind a toolbelt namespace.

bayma supplies the exact Rust 1.97.1 compiler and Cargo. A crate's source appears under `<packages>` the first time any bayma session declares it, and later sessions reuse it along with bayma's compile cache. Each Rust session begins with `:lockfile ~/.local/share/bayma/toolbelt/Cargo.lock`, so Cargo keeps every version `Cargo.lock` records, yanked releases included, and the session builds the graph this package set is tested against. Without it Cargo resolves each `:dep` fresh, and transitive dependencies drift to releases the lock does not record.

## Interactive Quickstart

Create the bayma Rust session with the directory you are working in as its `cwd`, and resolve its dependencies against the package set's lockfile:

```rust
:lockfile ~/.local/share/bayma/toolbelt/Cargo.lock
```

Declare the workbench dependencies together in one call so Cargo resolves one coherent graph:

```rust
:dep gix = { version = "=0.87.1", default-features = false, features = ["sha1", "sha256", "status", "revision", "parallel"] }
:dep grep = "=0.4.1"
:dep ignore = "=0.4.31"
:dep serde = { version = "=1.0.228", features = ["derive"] }
:dep serde_json = "=1.0.145"
:dep toml_edit = { version = "=0.25.13", features = ["serde"] }
```

Then use the crates directly:

```rust
let working_directory: std::path::PathBuf = std::env::current_dir().unwrap();
let repo_root: Option<std::path::PathBuf> = gix::discover(&working_directory)
    .ok()
    .and_then(|repository| repository.workdir().map(|path| path.to_path_buf()));
repo_root
```

You then have access to the tools the quickstart loads.

These tools can be used together in the same REPL to adeptly discover, inspect, parse, search, create, patch, rewrite, copy, move, rename, change permissions, safely remove, and otherwise work with whatever you would like.

An available package API can often do the same thing more directly, clearly, and reliably in the REPL than Bash, terminal commands, or spawned processes.

## Source And Type Inspection

Source and type inspection is useful for two things: understanding a repository or codebase, and understanding crates and their APIs, whether a project's dependencies, the toolbelt's, or any other crate. For Rust, the tools below do both within the session, so loaded crates, items, and types stay live in the REPL across cells, ready to be queried, compared, and built on, rather than reconstructed from a shell command's output each time.

For rust-analyzer work, use a fresh bayma Rust session rooted at the code being inspected and keep it as the dedicated source-and-type inspection workbench. Run the quickstart's `:lockfile` command first; then, before adding any unrelated dependencies, declare the exact rust-analyzer integration cohort together in one call:

```rust
:dep ra_ap_base_db = "=0.0.344"
:dep ra_ap_cfg = "=0.0.344"
:dep ra_ap_hir = "=0.0.344"
:dep ra_ap_ide = "=0.0.344"
:dep ra_ap_syntax = "=0.0.344"
```

Bind the tightly coupled cohort together in the next call so EVcxR loads one coherent set of crate metadata:

```rust
extern crate ra_ap_base_db;
extern crate ra_ap_cfg;
extern crate ra_ap_hir;
extern crate ra_ap_ide;
extern crate ra_ap_syntax;
```

Use `ra_ap_syntax` for rust-analyzer's full-fidelity, error-tolerant Rust source model. Work with `ra_ap_syntax::SourceFile`, `Parse`, `SyntaxNode`, `SyntaxToken`, `SyntaxKind`, `TextRange`, `TextSize`, `AstNode`, `AstToken`, `Edition`, `ast::Module`, `ast::Fn`, `ast::Struct`, `ast::Enum`, `ast::Trait`, `ast::Impl`, etc.; parse through `SourceFile::parse()`, inspect `Parse::errors()`, retain typed trees through `Parse::tree()`, traverse through `children()`, `descendants()`, `preorder()`, `preorder_with_tokens()`, etc., and use `algo`, `ast`, `syntax_editor`, and incremental `reparse()` APIs when their native models fit the task.

Use `ra_ap_hir` for semantic package and API structure over a configured rust-analyzer database. Work with `ra_ap_hir::Semantics`, `Crate`, `Module`, `ModuleDef`, `Function`, `Struct`, `Enum`, `Variant`, `Trait`, `Impl`, `AssocItem`, `Type`, `Callable`, `Visibility`, `Docs`, `PathResolution`, `SemanticsScope`, etc.; follow crates and modules through `root_module()`, `modules()`, `children()`, `declarations()`, `impl_defs()`, etc., inspect functions, fields, variants, generics, signatures, types, traits, implementations, attributes, documentation, and visibility through their native methods, and use semantic operations such as `to_def()`, `resolve_path()`, `type_of_expr()`, `resolve_expr_as_callable()`, `scope()`, `scope_at_offset()`, etc.

Use `ra_ap_ide::AnalysisHost` and its immutable `Analysis` snapshots for repository navigation and IDE-grade queries. Work with `ra_ap_ide::AnalysisHost`, `Analysis`, `FileId`, `FilePosition`, `FileRange`, `NavigationTarget`, `RangeInfo`, `HoverResult`, `CompletionItem`, `Diagnostic`, `Assist`, `SourceChange`, `TextEdit`, etc.; query through `parse()`, `file_structure()`, `crates_for()`, `goto_definition()`, `goto_declaration()`, `goto_implementation()`, `goto_type_definition()`, `find_all_refs()`, `hover()`, `signature_help()`, `call_hierarchy()`, `completions()`, `full_diagnostics()`, `rename()`, `assists_with_fixes()`, `structural_search_replace()`, `expand_macro()`, etc. Use `ra_ap_base_db` and `ra_ap_cfg` only to supply explicit files, source roots, crate graphs, editions, environments, and cfg options to the retained native `AnalysisHost`; they are project-input plumbing rather than additional source-inspection frameworks. Retain owned hosts, snapshots, paths, and results across EVcxR calls rather than references into earlier bindings.
