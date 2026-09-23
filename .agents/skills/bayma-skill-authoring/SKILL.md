---
name: bayma-skill-authoring
description: Use this whenever creating or updating a skill that uses Bayma in any way.
---

# Bayma Skill Authoring

Use this whenever creating or updating a skill that uses Bayma in any way.

This is not only for quickstart-oriented skills. Use it for any skill whose workflow depends on Bayma sessions, Bayma MCP tools, or Bayma-specific runtime assumptions.

## Quickstarts, If Useful

Not every skill that uses Bayma needs a quickstart.

If the skill would benefit from showing how to get a Bayma session into the right starting state, add one. In many integration-focused skills, you should consider adding a quickstart even if you were not initially planning to.

When a quickstart is present, keep it slick and maximally presumptive. Assume Bayma is installed, the host auth state already exists if relevant, and the needed packages are available from the session `cwd`. Do not clutter the quickstart with error handling.

The usual shape is:

1. Create a Bayma session with `mcp__bayma__session_create`, naming the `runtime` (`bun` for the example below).
2. In the first `mcp__bayma__exec`, initialize the integration exactly the way later execs will use it.
3. Store the long-lived client on `globalThis`.

Example:

```ts
import { SomeClient } from "some-package";

globalThis.someClient = new SomeClient({
  token: (await Bun.$`<command that prints the token>`.text()).trim(),
});
```

## Sources Of Truth And Available Modules

A Bayma session only has the package environment implied by its `cwd`. The session's available modules are whatever Bun can actually resolve from that working directory.

When writing a skill that uses Bayma, be explicit about the intended session `cwd` and the local files the agent should inspect before guessing at API shape or behavior.

Treat the installed package trees reachable from that session as the source of truth for how this machine is wired. Depending on the skill, that may mean:

- the repo-root `node_modules` tree
- a skill-local `node_modules` tree
- shipped type definitions
- generated request models
- bundled SDK docs or source-like files

If a skill relies on an SDK or library, tell the agent where to inspect it locally. The point is not only to know that a module is available, but to use the actual installed version correctly.

Examples:

- repo-root `node_modules/octokit` and `node_modules/@octokit/*`
- repo-root `node_modules/@google-cloud/*`
- skill-local `node_modules/@vercel/sdk`

Wrong `cwd` is often the real bug. If the relevant package tree is missing from the intended session `cwd`, the fix is usually to use the correct `cwd` or restore that install. Do not guess from memory, silently switch to a different package, or assume a package is available when the session cannot actually resolve it.

## Secrets In Session, If Needed

Because Bayma uses long-lived REPL sessions, you do not need to default to environment variables when setting secrets for in-session use.

If a skill needs to load one or more secrets at the beginning of a Bayma session, or later during the session, prefer initializing the client directly on `globalThis`. If you need to reuse several secret values, prefer one `globalThis.secrets` object.

Single secret:

```ts
globalThis.someClient = new SomeClient({
  token: (await Bun.$`<command that prints the token>`.text()).trim(),
});
```

Multiple secrets:

```ts
globalThis.secrets = {
  firstToken: (await Bun.$`<first command>`.text()).trim(),
  secondToken: (await Bun.$`<second command>`.text()).trim(),
};
```

Do not hardcode secrets in the skill and do not write them to repo files.

## Doctor Scripts, If The Skill Has A Quickstart

At the bottom of a quickstart, point users to the bundled doctor script as the first check if the quickstart did not work.

`scripts/bayma-doctor.sh` answers only the narrow question: can this machine find and keep bayma running at all? Pass a runtime (`bun`, `python`, `dotnet-script`, or `rust`) to check just that one; by default it reports all of them, with the install hint for any whose toolchain is missing.

## Troubleshooting Reference, If The Skill Has A Quickstart

If a skill includes a quickstart, also create a sibling reference file named `<thing-being-quickstarted>-bayma-quickstart-troubleshoot.md`.

Keep that file platform-independent. Put broader troubleshooting there, such as:

- the required package is not installed in the Bayma session `cwd`
- the session was created in the wrong `cwd`, so imports resolve against the wrong `node_modules`
- the host auth or secret-manager command is missing or not logged in
- the command exists on the host, but is not visible on `PATH` from the Bayma session
- the quickstart imported the wrong package or assumed the wrong runtime API

Keep the quickstart slick. Put broad troubleshooting in the separate troubleshoot file, and use the doctor script as the very first check.
