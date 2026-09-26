# bayma

A durable engine for REPL sessions. bayma allows agents to run and manage
long-lived, Jupyter-like code execution sessions. For an agent, an individual
bayma REPL session works like a Jupyter notebook, presented to it as an MCP
server whose function calls look similar to other "code mode" execution
interfaces.

## Get Started

On Linux (x64), with Docker, pull bayma's image, which holds everything
bundled with bayma: its runtimes, their toolbelt, and what it takes to keep
REPL sessions on disk.

```sh
docker pull ghcr.io/eaucoin/bayma
```

Then add bayma to your agent setup as an MCP server, for Claude Code or for
Codex:

```sh
BAYMA='exec docker run -i --rm --user "$(id -u):$(id -g)" -e HOME -v "$HOME:$HOME" -w "$PWD" --cap-add CHECKPOINT_RESTORE --cap-add SYS_PTRACE --security-opt seccomp=unconfined ghcr.io/eaucoin/bayma'
claude mcp add bayma -- sh -c "$BAYMA"
codex mcp add bayma -- sh -c "$BAYMA"
```

For any other MCP client, use `{"command": "sh", "args": ["-c", "<$BAYMA>"]}`.
bayma runs as you, with your home directory at its own path, and the last
three flags let it snapshot REPL sessions within its own container.
`docker run --rm ghcr.io/eaucoin/bayma doctor` checks that each runtime works.

REPL sessions are kept under `~/.local/state/bayma`, one directory per project
directory the client launched from. When bayma stops, it snapshots each idle
REPL session, its whole process and everything it holds, and a later bayma
restores it where it left off; after a reboot, a REPL session comes back from
its own checkpoints instead.

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
`.github/workflows/` for the GitHub Actions workflows, and
`.agents/skills/development-observability/` for development observability.
