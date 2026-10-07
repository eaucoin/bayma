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

To move to the latest bayma, run

```sh
npx bayma-repl@latest upgrade
```

and restart your MCP clients: a REPL session snapshotted by another version
comes back from its checkpoints rather than live. `npx bayma-repl uninstall`
takes bayma off again, and with `--purge`, REPL sessions' state too.

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
