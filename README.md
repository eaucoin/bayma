# bayma

A durable engine for REPL sessions. bayma allows agents to run and manage
long-lived, Jupyter-like code execution sessions. For an agent, an individual
bayma REPL session works like a Jupyter notebook, presented to it as an MCP
server whose function calls look similar to other "code mode" execution
interfaces.

## Get Started

On Linux (x64) or macOS (Apple Silicon), add bayma to your agent setup as an
MCP server, for Claude Code or for Codex:

```sh
claude mcp add bayma -- npx -y @bayma-repl/bayma mcp-stdio
codex mcp add bayma -- npx -y @bayma-repl/bayma mcp-stdio
```

Codex gives an MCP server 10 seconds to start, and bayma's first launch takes
longer, so before starting Codex, give bayma a minute in `~/.codex/config.toml`:

```toml
[mcp_servers.bayma]
command = "npx"
args = ["-y", "@bayma-repl/bayma", "mcp-stdio"]
startup_timeout_sec = 60
```

For any other MCP client, use `{"command": "npx", "args": ["-y", "@bayma-repl/bayma", "mcp-stdio"]}`.
`npx @bayma-repl/bayma doctor` checks that each runtime works, and REPL
sessions are kept under `~/.local/state/bayma`, one directory per project
directory the client launched from.

Then you can use bayma. Each runtime has a skill, `bayma-runtime-*`, on how to
work in that runtime with bayma. Within a REPL session, an agent executes code
in that runtime, including against legacy software. For example, in the C++
runtime, with libardour, it can run a headless digital audio workstation:

```sh
npx skills add eaucoin/bayma --skill bayma-runtime-cpp bayma-platform-ardour
```

or with MLT++, a headless non-linear editor for video:

```sh
npx skills add eaucoin/bayma --skill bayma-runtime-cpp bayma-platform-mltpp
```

Or in the Python runtime, with bpy, it can model, animate, and render 3D
scenes in a headless Blender:

```sh
npx skills add eaucoin/bayma --skill bayma-runtime-python bayma-platform-bpy
```

Each of these is a `bayma-platform-*` skill: one per platform, meaning an
application or service an agent drives through its API. The skill shows where
that API's reference is, and keeps what the platform needs in its own folder
rather than being bundled with bayma.

Within each of the two namespaces, the skills share a similar structure, which
makes it easier to add new runtimes and platforms.

## Development

See `package.json` for the development scripts, `.github/workflows/` for the
GitHub Actions workflows, and `.agents/skills/development-observability/` for
development observability.
