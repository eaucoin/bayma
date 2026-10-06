import { join } from "node:path";

// Where bayma keeps things on this machine, as its container sees them. The
// container is given HOME alone, so the XDG directories bayma uses there
// (packages/core/src/paths.ts) are HOME's defaults, and so are these,
// whatever XDG_* says here.

/** What bayma keeps for good: the toolbelt, and this command's installs. */
export function dataRoot(home: string): string {
  return join(home, ".local", "share", "bayma");
}

/** REPL sessions' state: one directory per directory a server launched from. */
export function stateRoot(home: string): string {
  return join(home, ".local", "state", "bayma");
}

/** What bayma can make again, safe to delete at any time. */
export function cacheRoot(home: string): string {
  return join(home, ".cache", "bayma");
}

/** Where `bayma install-toolbelt` installs the toolbelt bundled with bayma. */
export function toolbeltDir(home: string): string {
  return join(dataRoot(home), "toolbelt");
}

/** The file in an installed toolbelt naming the version it was copied from. */
export const TOOLBELT_VERSION_FILE = ".bayma-toolbelt-version";

/** Where each installed version of this command is kept, by version. */
export function cliRoot(home: string): string {
  return join(dataRoot(home), "cli");
}

/** The installed command of `version`, the one MCP clients launch. */
export function installedCli(home: string, version: string): string {
  return join(cliRoot(home), version, "bayma.js");
}
