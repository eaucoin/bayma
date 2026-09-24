# bayma

A durable engine for REPL sessions. bayma allows agents to run and manage
long-lived, Jupyter-like code execution sessions. For an agent, an individual
bayma session works like a Jupyter notebook, presented to it as an MCP server
whose function signatures look similar to other "code mode" execution
interfaces. Agents can create a fresh REPL session by selecting a supported
runtime and working directory of their choice; within that session they
execute code snippets that build on each other, importing the packages and
modules that the REPL bayma builds on for that language resolves from that
working directory (see the bullets below). Under the hood, bayma mimics other
code mode implementations in how an agent can sit on an execution by yielding
or waiting, while viewing segments of the execution's output stream.

## Supported REPL runtimes

bayma currently supports eight REPL runtimes:

- **Bun** — JavaScript and TypeScript, built on Bun's own REPL (`bun repl`)
- **Python** — built on CPython, driven by a bayma harness that compiles each
  cell with top-level `await` support
- **C#** — built on dotnet-script, the Roslyn scripting REPL
- **Rust** — built on EVcxR, embedded as a library rather than driven as a
  terminal program
- **C** and **C++** — built on Clang's incremental Interpreter, the library
  behind clang-repl, embedded rather than driven as a terminal program; C++ is
  C++23 with libc++. A `compile_flags.txt` in the session's working directory,
  as clangd reads it, sets the compiler's arguments and loads libraries, whose
  templates, types, and thread-local variables cells share as a linked program
  would; on Linux it can choose GCC's libstdc++, which distributions build their
  C++ libraries with
- **Lean** — Lean 4, on Lean's own frontend in a bayma host: each cell
  elaborates on the environment the one before it left. A Lake project in the
  session's working directory supplies its libraries, such as Mathlib, once
  built with the `lake` bayma brings
- **Go** — compiled by Go's own toolchain: each cell becomes a package, built
  as a plugin and loaded into one process that stays alive, so a session is one
  package that grows a cell at a time, importing any module, fetched through
  the Go module proxy

Each of them is bundled: bayma runs pinned toolchains it brings itself, not
whatever happens to be installed. The one exception is on macOS, where C, C++,
and Go's cells compile against the SDK of the Xcode Command Line Tools, which
cannot be redistributed; install them with `xcode-select --install`.

## Install

bayma is published to npm as `@bayma-repl/bayma`, for Linux (x64) and macOS
(Apple Silicon), on Node.js 22.13 or newer.

For Claude Code:

```sh
claude mcp add bayma -- npx -y @bayma-repl/bayma mcp-stdio
```

For Codex:

```sh
codex mcp add bayma -- npx -y @bayma-repl/bayma mcp-stdio
```

Then, before starting Codex, give bayma a minute to start: its first launch
downloads bayma's runtimes, which takes longer than the 10 seconds Codex allows
by default. In `~/.codex/config.toml`:

```toml
[mcp_servers.bayma]
command = "npx"
args = ["-y", "@bayma-repl/bayma", "mcp-stdio"]
startup_timeout_sec = 60
```

For any other MCP client, use `{"command": "npx", "args": ["-y", "@bayma-repl/bayma", "mcp-stdio"]}`.

bayma manages the runtimes for you. Installing it downloads a single archive —
Bun, Python, .NET, Rust, Clang, Lean, and Go, and the toolbelt below — into
`~/.cache/bayma`, about 1.8 GB, once per version. Nothing on your machine is used or needed
beyond Node, and every install runs the same versions.
`npx @bayma-repl/bayma doctor` checks that each runtime works.

Sessions are kept under `~/.local/state/bayma`, one directory per project
directory the client launched from.

## Toolbelt

The toolbelt is baked into bayma's setup: bayma installs it with its runtimes,
at `~/.local/share/bayma/toolbelt`, from the same archive and at the same
pinned versions. It gives every session pinned Bun, Python, and Rust packages
for discovering, searching, parsing, editing, and testing code, and the
`bayma-toolbelt` skill teaches an agent to load them into a session and work
with them.

## Platforms

There is also a `bayma-platform` namespace of skills. Each shows an agent how
to have bayma interact with a platform and gives it that platform's
capabilities, keeping what the platform needs in the skill's own folder rather
than installing anything with bayma.

Add the skills with

```sh
npx skills add eaucoin/bayma
```

## Development

Requires Bun 1.3.14 (the package manager, test runner, and bundler) and
Node.js 22.13+, which is what bayma itself runs on. The toolchains come from
`provision`, not from your machine; it needs only `zstd` and a linker (GNU
binutils on Linux, the Xcode Command Line Tools on macOS).

```sh
bun install
bun run build        # bundle the server and the installer for Node into dist
bun run provision    # download and verify every pinned toolchain, and build the toolbelt, into .work
bun run payload      # assemble dist/payload and its release tarball
bun run test         # unit, integration, and tooling tests, against that payload
bun run release      # write dist/payloads.json from the payload tarballs
bun run pack         # stage the package and npm pack it into dist
bun run test:e2e     # npm install the tarball and drive every runtime through it
```

The layout is `packages/` (engine, adapters, the published package; the Rust,
C/C++, Lean, and Go host sources live in their adapters), `toolbelt/` (the toolbelt's code and
lockfiles), `skills/` (the toolbelt and platform skills), `tooling/` (pins,
provisioning, payload, publish), `tests/`.
