# bayma

A durable engine for REPL sessions. bayma allows agents to run and manage
long-lived, Jupyter-like code execution sessions. For an agent, an individual
bayma REPL session works like a Jupyter notebook, presented to it as an MCP
server whose function calls look similar to other "code mode" execution
interfaces.

## Get Started

On Linux (x64), with Docker and Node 22 or later, set bayma up:

```sh
npx bayma init
```

This pulls bayma's image of the same version, pinned by digest, which holds
everything bundled with bayma: its runtimes, their toolbelt, and what it
takes to keep REPL sessions on disk. It installs the toolbelt, checks with
bayma's doctor that each runtime works, and adds bayma as an MCP server to
Claude Code and to Codex, where they are installed, printing what any other
MCP client takes. Your MCP clients then launch bayma in a container of its
own, running as you, with your home directory at its own path, and allowed
to snapshot REPL sessions within it. `npx bayma status` shows what is set up,
and `npx bayma doctor` checks each runtime again.

To move to the latest bayma, run

```sh
npx bayma@latest upgrade
```

and restart your MCP clients: a REPL session snapshotted by another version
comes back from its checkpoints rather than live. `npx bayma uninstall` takes
bayma off again, and with `--purge`, REPL sessions' state too.

REPL sessions are kept under `~/.local/state/bayma`, one directory per project
directory the client launched from. When bayma stops, it snapshots each idle
REPL session, its whole process and everything it holds, and a later bayma
restores it where it left off; after a reboot, a REPL session comes back from
its own checkpoints instead.

bayma exports OpenTelemetry traces, metrics, and logs of its own work, over
OTLP's HTTP protocols, to wherever `OTEL_EXPORTER_OTLP_ENDPOINT` and
OpenTelemetry's other standard variables say, as set where your MCP client
launches it; with none set, it exports nothing. It reads them within its
container, so `localhost` there is the container itself. Each MCP
request is a span that continues the trace its client propagated, in the
request's `_meta` or its `traceparent` header, with spans for the execs,
runtimes, and REPL sessions it concerns. A REPL session is never told where
bayma exports.

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

What code in a REPL session renders, such as a plot, a screenshot, or a
frame, it can show the agent as an image beside the exec's output; each
runtime's skill names the helper that shows one.

Within each of the two namespaces, the skills share a similar structure, which
makes it easier to add new runtimes and platforms.

## Development

See `package.json` for the development scripts, `Dockerfile` for the image,
`packages/cli` for the `bayma` command npm publishes, `.github/workflows/` for
the GitHub Actions workflows, and
`.agents/skills/development-observability/` for development observability.
