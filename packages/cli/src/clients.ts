import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

// The MCP clients bayma registers itself with, through their own commands,
// and what each has registered, read from its configuration.

/** The name bayma is registered under in every client. */
export const SERVER_NAME = "bayma";

/** What an MCP client launches to start bayma's stdio server. */
export interface LaunchCommand {
  command: string;
  args: string[];
}

/** An MCP client with a command that registers servers. */
export interface McpClient {
  name: string;
  executable: string;
  /** The arguments that register `launch`, at the scope of the whole user. */
  add(launch: LaunchCommand): string[];
  remove: string[];
  /** What it has registered as bayma, or undefined when nothing. */
  registered(
    home: string,
    env: Readonly<Record<string, string | undefined>>,
  ): LaunchCommand | undefined;
}

/**
 * Claude Code keeps servers registered for the user in .claude.json, in
 * CLAUDE_CONFIG_DIR or else the home directory.
 */
function claudeRegistration(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): LaunchCommand | undefined {
  const path = join(env.CLAUDE_CONFIG_DIR || home, ".claude.json");
  if (!existsSync(path)) return undefined;
  const config = JSON.parse(readFileSync(path, "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>;
  };
  const server = config.mcpServers?.[SERVER_NAME];
  if (server?.command === undefined) return undefined;
  return { command: server.command, args: server.args ?? [] };
}

/** A TOML string as Codex writes one: basic, as JSON's, or literal. */
function tomlStrings(text: string): string[] {
  return [...text.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map(([value]) =>
    value.startsWith("'") ? value.slice(1, -1) : (JSON.parse(value) as string),
  );
}

/**
 * Codex keeps its servers in config.toml, in CODEX_HOME or else ~/.codex, a
 * table each; this reads as much TOML as Codex writes for one.
 */
function codexRegistration(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): LaunchCommand | undefined {
  const path = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n");
  const header = lines.findIndex((line) =>
    /^\s*\[\s*mcp_servers\s*\.\s*(bayma|"bayma")\s*\]\s*$/.test(line),
  );
  if (header === -1) return undefined;
  const end = lines.findIndex(
    (line, index) => index > header && /^\s*\[/.test(line),
  );
  const table = lines
    .slice(header + 1, end === -1 ? undefined : end)
    .join("\n");
  const command = /^\s*command\s*=\s*(.*)$/m.exec(table)?.[1];
  const args = /^\s*args\s*=\s*\[([^\]]*)\]/m.exec(table)?.[1];
  if (command === undefined) return undefined;
  const [executable] = tomlStrings(command);
  if (executable === undefined) return undefined;
  return {
    command: executable,
    args: args === undefined ? [] : tomlStrings(args),
  };
}

export const MCP_CLIENTS: readonly McpClient[] = [
  {
    name: "Claude Code",
    executable: "claude",
    add: ({ command, args }) => [
      "mcp",
      "add",
      "--scope",
      "user",
      SERVER_NAME,
      "--",
      command,
      ...args,
    ],
    remove: ["mcp", "remove", "--scope", "user", SERVER_NAME],
    registered: claudeRegistration,
  },
  {
    name: "Codex",
    executable: "codex",
    add: ({ command, args }) => [
      "mcp",
      "add",
      SERVER_NAME,
      "--",
      command,
      ...args,
    ],
    remove: ["mcp", "remove", SERVER_NAME],
    registered: codexRegistration,
  },
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `name` is on `env`'s PATH, or `name` itself when it is a path. */
export function findExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (name.includes("/")) return isExecutable(name) ? name : undefined;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** What a command came to: its status, and what it wrote. */
export interface CommandResult {
  status: number;
  output: string;
}

/** Runs `file` with `args` to its end, collecting what it writes. */
export function runCommand(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code ?? 1, output }));
  });
}

/** A client's registration replaced with `launch`, or why it failed. */
export async function register(
  client: McpClient,
  executable: string,
  launch: LaunchCommand,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CommandResult> {
  // Neither client replaces a server by adding it again, so whatever is
  // registered as bayma goes first; there being none is no failure.
  await runCommand(executable, client.remove, env);
  return runCommand(executable, client.add(launch), env);
}

/** Why a registration would not start bayma, if it would not. */
export function registrationProblem(
  launch: LaunchCommand,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const [cli, command] = launch.args;
  if (!findExecutable(launch.command, env))
    return isAbsolute(launch.command)
      ? `${launch.command} is not there to run`
      : `${launch.command} is not on PATH`;
  if (cli === undefined || !existsSync(cli))
    return `${cli ?? "no command"} is not there`;
  if (command !== "mcp-stdio") return `it does not run mcp-stdio`;
  return undefined;
}
