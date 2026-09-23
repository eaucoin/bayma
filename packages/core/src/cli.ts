import type { RuntimeAdapter } from "./runtime/adapter.ts";
import { parseRuntimeId } from "./runtime/id.ts";
import { applyPayloadEnvironment } from "./runtime/payload-environment.ts";
import { ensurePayload } from "./runtime/payload.ts";
import { runDoctor } from "./doctor.ts";
import { serveMcpHttp } from "./mcp/http.ts";
import { serveMcpStdio } from "./mcp/stdio.ts";
import { defaultStateDir } from "./paths.ts";
import { BAYMA_VERSION } from "./version.ts";
import type { DurabilityMode } from "./session/model.ts";

// The command surface of the `bayma` binary.

const BINARY = "bayma";

export function parseCliOptions(
  args: string[],
  allowedNames: readonly string[],
): ReadonlyMap<string, string> {
  const allowed = new Set(allowedNames);
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];
    if (!allowed.has(name)) throw new Error(`unknown option ${name}`);
    if (parsed.has(name))
      throw new Error(`option ${name} may be provided only once`);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option ${name} requires one value`);
    }
    parsed.set(name, value);
  }
  return parsed;
}

function option(
  options: ReadonlyMap<string, string>,
  name: string,
  fallback: string,
): string {
  return options.get(name) ?? fallback;
}

function defaultDurability(
  options: ReadonlyMap<string, string>,
): DurabilityMode {
  const value = option(options, "--default-durability", "ephemeral");
  if (value !== "ephemeral" && value !== "checkpointed") {
    throw new Error("--default-durability must be ephemeral or checkpointed");
  }
  return value;
}

const SERVER_OPTIONS = [
  "--state-dir",
  "--max-sessions",
  "--warn-usage-percent",
  "--snapshot-token-limit",
  "--cols",
  "--rows",
  "--default-durability",
] as const;

function serverConfig(parsed: ReadonlyMap<string, string>) {
  const durabilityMode = defaultDurability(parsed);
  return {
    stateDir: option(parsed, "--state-dir", defaultStateDir(process.cwd())),
    maxSessions: Number(option(parsed, "--max-sessions", "32")),
    warnUsagePercent: Number(option(parsed, "--warn-usage-percent", "75")),
    snapshotTokenLimit: Number(
      option(parsed, "--snapshot-token-limit", "10000"),
    ),
    defaultCols: Number(option(parsed, "--cols", "120")),
    defaultRows: Number(option(parsed, "--rows", "40")),
    resolveCreatePolicy: () => ({ durabilityMode }),
  };
}

function usage(): void {
  console.log(`Usage: ${BINARY} <command>

Commands:
  version
      print the current version
  mcp-stdio [--state-dir PATH] [--max-sessions N] [--warn-usage-percent N]
      [--snapshot-token-limit N] [--cols N] [--rows N]
      [--default-durability ephemeral|checkpointed]
      serve MCP over stdio
  mcp-http [--host HOST] [--port N] [--path PATH] [--state-dir PATH]
      [--max-sessions N] [--warn-usage-percent N]
      [--snapshot-token-limit N] [--cols N] [--rows N]
      [--default-durability ephemeral|checkpointed]
      serve MCP over Streamable HTTP
  doctor [--runtime all|bun|python|dotnet-script|rust]
      [--cwd PATH] [--state-dir PATH] [--format text|json]
      report which runtimes this machine can run and prove each one by
      executing code in it; a named runtime must be available
  help
      show this help`);
}

export async function runCli(
  adapters: readonly RuntimeAdapter[],
): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "version":
    case "--version":
    case "-V": {
      parseCliOptions(args, []);
      console.log(BAYMA_VERSION);
      return;
    }
    case "mcp-stdio": {
      applyPayloadEnvironment(await ensurePayload());
      await serveMcpStdio(
        adapters,
        serverConfig(parseCliOptions(args, SERVER_OPTIONS)),
      );
      return;
    }
    case "mcp-http": {
      const parsed = parseCliOptions(args, [
        "--host",
        "--port",
        "--path",
        ...SERVER_OPTIONS,
      ]);
      applyPayloadEnvironment(await ensurePayload());
      await serveMcpHttp(adapters, {
        host: option(parsed, "--host", "127.0.0.1"),
        port: Number(option(parsed, "--port", "7290")),
        path: option(parsed, "--path", "/mcp"),
        ...serverConfig(parsed),
      });
      return;
    }
    case "doctor": {
      const parsed = parseCliOptions(args, [
        "--runtime",
        "--cwd",
        "--state-dir",
        "--format",
      ]);
      const outputFormat = option(parsed, "--format", "text");
      if (outputFormat !== "text" && outputFormat !== "json") {
        throw new Error("--format must be text or json");
      }
      const requested = option(parsed, "--runtime", "all");
      const selected =
        requested === "all"
          ? adapters
          : adapters.filter(
              ({ runtimeId }) => runtimeId === parseRuntimeId(requested),
            );
      if (selected.length === 0)
        throw new Error(`runtime is unavailable: ${requested}`);
      applyPayloadEnvironment(await ensurePayload());
      await runDoctor(selected, {
        cwd: option(parsed, "--cwd", process.cwd()),
        stateDir: parsed.get("--state-dir"),
        outputFormat,
      });
      return;
    }
    case "help":
    case "--help":
    case "-h": {
      parseCliOptions(args, []);
      usage();
      return;
    }
    default:
      usage();
      process.exitCode = 2;
  }
}
