# bayma

A durable engine for REPL sessions. bayma allows agents to run and manage
long-lived, Jupyter-like code execution sessions. For an agent, an individual
bayma REPL session works like a Jupyter notebook, presented to it as an MCP
server whose function calls look similar to other "code mode" execution
interfaces.

It supports eight REPL runtimes, including Bun, Python, Lean, and Go.

## Get Started

On Linux (x64), with Docker and Node 22 or later, set bayma up:

```sh
npx bayma-repl init
```

This pulls bayma's image of the same version, pinned by digest, which holds
everything bundled with bayma: its runtimes, their toolbelt, and what it
takes to keep REPL sessions on disk. It installs the toolbelt, checks with
bayma's doctor that each runtime works, and adds bayma as an MCP server to
Claude Code and to Codex, where they are installed, printing what any other
MCP client takes. Your MCP clients then launch bayma in a container of its
own, running as you, with your home directory at its own path, on your
machine's network, so `localhost` is your machine, and allowed to snapshot
REPL sessions within it. `npx bayma-repl status` shows what is set up, and
`npx bayma-repl doctor` checks each runtime again.

To move to the latest bayma, run

```sh
npx bayma-repl@latest upgrade
```

and restart your MCP clients: a REPL session snapshotted by another version
comes back from its checkpoints rather than live. `npx bayma-repl uninstall`
takes bayma off again, and with `--purge`, REPL sessions' state too.

REPL sessions are kept under `~/.local/state/bayma`, or `$XDG_STATE_HOME/bayma`
when that is set under your home, one directory per project directory the
client launched from. When bayma stops, it snapshots each idle REPL session,
its whole process and everything it holds, and a later bayma restores it where
it left off; after a reboot, a REPL session comes back from its own
checkpoints instead.

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

See `package.json` for the development scripts, `Dockerfile` for the image,
`packages/cli` for the `bayma` command npm publishes as `bayma-repl`,
`.github/workflows/` for the GitHub Actions workflows, and
`.agents/skills/development-observability/` for development observability.
