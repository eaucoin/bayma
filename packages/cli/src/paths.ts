import { isAbsolute, join, relative, sep } from "node:path";

// Where bayma keeps things on this machine, by the rules bayma follows in its
// container (packages/core/src/paths.ts): each XDG base directory set, else
// HOME's default for it. The container is given HOME, which is mounted at its
// own path, and each XDG base directory set here, so these are the places
// bayma there uses too.

/** HOME and the XDG base directories, as the container is given them. */
export type PathEnvironment = Readonly<Record<string, string | undefined>>;

/** The XDG base directories bayma keeps things under. */
export const XDG_DIRECTORIES = [
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;

/**
 * The environment that tells bayma's container where its places are: HOME,
 * and each XDG base directory `env` sets. Only HOME is mounted, so one set
 * outside it would be a directory the container cannot reach.
 */
export function pathEnvironment(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const paths: Record<string, string> = { HOME: home };
  for (const variable of XDG_DIRECTORIES) {
    const value = env[variable];
    // Set to nothing is unset, as bayma reads it.
    if (!value) continue;
    const within = relative(home, value);
    if (
      !isAbsolute(value) ||
      within === ".." ||
      within.startsWith(`..${sep}`) ||
      isAbsolute(within)
    )
      throw new Error(
        `${variable} is ${value}, outside HOME (${home}), the one directory bayma's container is given: unset it, or set it to a directory under HOME`,
      );
    paths[variable] = value;
  }
  return paths;
}

function xdgRoot(
  env: PathEnvironment,
  variable: (typeof XDG_DIRECTORIES)[number],
  fallback: readonly string[],
): string {
  const configured = env[variable];
  return configured
    ? join(configured, "bayma")
    : join(env.HOME!, ...fallback, "bayma");
}

/** What bayma keeps for good: the toolbelt, and this command's installs. */
export function dataRoot(env: PathEnvironment): string {
  return xdgRoot(env, "XDG_DATA_HOME", [".local", "share"]);
}

/** REPL sessions' state: one directory per directory a server launched from. */
export function stateRoot(env: PathEnvironment): string {
  return xdgRoot(env, "XDG_STATE_HOME", [".local", "state"]);
}

/** What bayma can make again, safe to delete at any time. */
export function cacheRoot(env: PathEnvironment): string {
  return xdgRoot(env, "XDG_CACHE_HOME", [".cache"]);
}

/** Where `bayma install-toolbelt` installs the toolbelt bundled with bayma. */
export function toolbeltDir(env: PathEnvironment): string {
  return join(dataRoot(env), "toolbelt");
}

/** The file in an installed toolbelt naming the version it was copied from. */
export const TOOLBELT_VERSION_FILE = ".bayma-toolbelt-version";

/** Where each installed version of this command is kept, by version. */
export function cliRoot(env: PathEnvironment): string {
  return join(dataRoot(env), "cli");
}

/** The installed command of `version`, the one MCP clients launch. */
export function installedCli(env: PathEnvironment, version: string): string {
  return join(cliRoot(env), version, "bayma.js");
}
