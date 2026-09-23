---
name: bayma-toolbelt
description: Mandatory essential tools for working on this project.
---

# bayma-toolbelt

Each quickstart below loads a pinned set of packages into a bayma session: Bun and Python gather theirs into one `toolbelt` namespace, and Rust declares its crates directly. The toolbelt itself, its code, lockfiles, and installed packages, lives in `~/.local/share/bayma/toolbelt` (under `$XDG_DATA_HOME/bayma/toolbelt` when that is set), where bayma installs it with its runtimes; if it is missing, `npx @bayma-repl/bayma doctor` installs it. This skill shows where their source, types, and documentation live, so code written against them, or executed interactively with them, is correct.

## Reference Materials

### Bun

The source, types, and documentation behind the Bun `toolbelt` namespace are under:

```text
<toolbelt> = ~/.local/share/bayma/toolbelt
<packages> = <toolbelt>/node_modules

toolbelt.simpleGit        <packages>/simple-git/** (bound to the enclosing repository)
toolbelt.astGrep.napi     <packages>/@ast-grep/napi/**
toolbelt.astGrep.python   <packages>/@ast-grep/lang-python/**
toolbelt.manypkg          <packages>/@manypkg/get-packages/**
toolbelt.ripgrep          <packages>/@vscode/ripgrep/**
toolbelt.diff             <packages>/diff/**
toolbelt.editorconfig     <packages>/editorconfig/**
toolbelt.execa            <packages>/execa/**
toolbelt.xml              <packages>/fast-xml-parser/**
toolbelt.globby           <packages>/globby/**
toolbelt.isBinaryFile     <packages>/isbinaryfile/**
toolbelt.jsonc            <packages>/jsonc-parser/**
toolbelt.lruCache         <packages>/lru-cache/**
toolbelt.markdown         <packages>/mdast-util-from-markdown/**
toolbelt.pMap             <packages>/p-map/**
toolbelt.remeda           <packages>/remeda/**
toolbelt.toml             <packages>/smol-toml/**
toolbelt.tsMorph          <packages>/ts-morph/**
toolbelt.vitest           <packages>/vitest/**
toolbelt.writeFileAtomic  <packages>/write-file-atomic/**
toolbelt.yaml             <packages>/yaml/**
```

The Bun helper that assembles this namespace is `<toolbelt>/toolbelt.ts`.

### Python

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

### Rust

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

### Bun

In a bayma Bun session:

```ts
const toolbeltRoot = `${process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`}/bayma/toolbelt`;
Object.assign(
  globalThis,
  await (await import(`${toolbeltRoot}/toolbelt.ts`)).openToolbelt(),
);
undefined;
```

`repoRoot` is the Git repository containing the session's working directory, or `null` outside one, in which case `toolbelt.simpleGit` is absent.

### Python

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

### Rust

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

You then have access to the tools for the selected quickstart.

These tools can be used together in the same REPL to adeptly discover, inspect, parse, search, create, patch, rewrite, copy, move, rename, change permissions, safely remove, and otherwise work with whatever you would like.

Avoid Bash, terminal commands, and spawned processes when an available package API models the work more directly, clearly, and reliably in the REPL.

## Repository Operations

Use the ordinary Git libraries below for repository inspection and staging. Commits, merges, and pushes should run a repository's own Git hooks; the libraries differ in whether they do, so the choice below keeps those operations on real Git.

### Bun

Use the repository-bound `toolbelt.simpleGit` client for inspection, staging, commits, merges, and pushes. simple-git drives the `git` executable, so every operation honors the repository's configuration and hooks.

### Python

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

### Rust

Use ordinary `gix` APIs for local repository inspection, such as `gix::discover(&working_directory)`. Commit, merge, and push with the `git` executable through `std::process::Command`; gix does not run a repository's hooks.

## Source And Type Inspection

Source and type inspection serves two main purposes: understanding a codebase's source and APIs directly, and discovering how to accomplish work through the toolbelt without falling back to Bash, terminal commands, or spawned processes. The latter is especially important: for most discovering, inspecting, parsing, searching, creating, patching, rewriting, copying, moving, renaming, and so forth, there exists a programmatic toolbelt package or library that models the task more directly, clearly, reliably, and composably. Use the language-appropriate tools and frameworks below in the bayma session for both purposes—to inspect the code you are working on and to understand and use the available package APIs effectively.

### Bun

Use ts-morph through `toolbelt.tsMorph` to ground package and repository API understanding in source and type declarations. Work with exports such as `toolbelt.tsMorph.Project`, `toolbelt.tsMorph.SourceFile`, `toolbelt.tsMorph.ClassDeclaration`, `toolbelt.tsMorph.FunctionDeclaration`, `toolbelt.tsMorph.InterfaceDeclaration`, `toolbelt.tsMorph.TypeAliasDeclaration`, `toolbelt.tsMorph.EnumDeclaration`, `toolbelt.tsMorph.VariableDeclaration`, `toolbelt.tsMorph.ModuleDeclaration`, etc.; follow the declaration, symbol, and type objects returned by those APIs through operations such as `sourceFile.getExportedDeclarations()`, `declaration.getSymbol()`, `declaration.getType()`, `type.getCallSignatures()`, `signature.getReturnType()`, `declaration.findReferences()`, etc.

### Python

Use Griffe through `toolbelt.griffe` for static package and API structure, Jedi through `toolbelt.jedi` for semantic code intelligence, and `inspect` plus `importlib` when live runtime truth is required. Work with Griffe exports such as `toolbelt.griffe.GriffeLoader`, `toolbelt.griffe.Module`, `toolbelt.griffe.Class`, `toolbelt.griffe.Function`, `toolbelt.griffe.Attribute`, `toolbelt.griffe.Alias`, `toolbelt.griffe.ObjectKind`, `toolbelt.griffe.Docstring`, etc.; load modules through `toolbelt.griffe.load()` or `loader.load()`, inspect `module.members`, `object.all_members`, `class.inherited_members`, `function.parameters`, `function.returns`, `object.annotation`, `object.docstring`, `object.source`, `object.filepath`, `object.lineno`, `object.endlineno`, etc., and resolve aliases through `loader.resolve_aliases()`.

Use `toolbelt.jedi.Project`, `toolbelt.jedi.Script`, `toolbelt.jedi.Interpreter`, etc., with operations such as `get_names()`, `infer()`, `goto()`, `get_references()`, `get_signatures()`, `complete()`, `search()`, etc. Inspect the returned names, definitions, signatures, parameters, completions, etc., through properties such as `name`, `type`, `full_name`, `module_path`, `line`, `column`, `description`, `params`, etc. For imported runtime objects, use `inspect.getmembers()`, `inspect.signature()`, `inspect.getsource()`, `inspect.getsourcelines()`, `inspect.get_annotations()`, `inspect.unwrap()`, etc., together with `importlib.import_module()`, `importlib.util.find_spec()`, `importlib.metadata`, etc.

### Rust

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

Package-backed `toolbelt.*` surfaces expose ordinary modules and clients. Bun's `toolbelt.vitest.run` starts Vitest in Node from the project's own install, since Vitest cannot start under Bun, and returns its JSON report; `toolbelt.simpleGit` is bound to the enclosing repository. Python additionally exposes a genuine Dulwich `Repo` bound to the enclosing repository, and bounded helpers for atomic writes, package-root discovery, isolated pytest and Ruff execution, project-owned uv execution, and focused in-process `unittest` execution. Rust exposes ordinary pinned crates directly.
