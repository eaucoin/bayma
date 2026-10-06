import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RuntimeAdapter } from "./runtime/adapter.ts";
import { parseRuntimeId, RUNTIME_IDS } from "./runtime/id.ts";
import { applyPayloadEnvironment } from "./runtime/payload-environment.ts";
import { requirePayloadDir } from "./runtime/payload.ts";
import {
  installToolbelt,
  startToolbeltInstall,
  toolbeltPath,
  type ToolbeltInstall,
} from "./runtime/toolbelt.ts";
import { runDoctor } from "./doctor.ts";
import { serveMcpHttp } from "./mcp/http.ts";
import { serveMcpStdio } from "./mcp/stdio.ts";
import { defaultStateDir } from "./paths.ts";
import { failureDetail, failureMessage } from "./errors.ts";
import { startTelemetry, stopTelemetry } from "./telemetry/index.ts";
import { log, report, SeverityNumber } from "./telemetry/record.ts";
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

// Sessions outlive the server unless a server is told otherwise.
function defaultDurability(
  options: ReadonlyMap<string, string>,
): DurabilityMode {
  const value = option(options, "--default-durability", "checkpointed");
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
      [--default-durability checkpointed|ephemeral]
      serve MCP over stdio
  mcp-http [--host HOST] [--port N] [--path PATH] [--state-dir PATH]
      [--max-sessions N] [--warn-usage-percent N]
      [--snapshot-token-limit N] [--cols N] [--rows N]
      [--default-durability checkpointed|ephemeral]
      [--client-idle-timeout-ms N] [--token-file PATH]
      serve MCP over Streamable HTTP; a client session with no request or
      stream open for the idle timeout, five minutes unless given, is
      closed; with --token-file, every request must carry the file's
      token as Authorization: Bearer
  doctor [--runtime ${["all", ...RUNTIME_IDS].join("|")}]
      [--cwd PATH] [--state-dir PATH] [--format text|json]
      report which runtimes this machine can run and prove each one by
      executing code in it; a named runtime must be available; and report
      whether sessions can be snapshotted here, and if not, why
  install-toolbelt
      install the toolbelt bundled with bayma where the runtime skills name
      it, unless the toolbelt there is already this version's; a server
      installs it in the background as it starts, and doctor before it
      reports
  help
      show this help

Sessions are checkpointed by default: they outlive the server, whole where
the server can snapshot their processes, and otherwise from their
checkpoints. --default-durability ephemeral ends them with the server.

OpenTelemetry traces, metrics, and logs of bayma's work are exported over
OTLP to wherever OTEL_EXPORTER_OTLP_ENDPOINT and OpenTelemetry's other
standard variables say; with none set, nothing is exported.`);
}

/**
 * Telemetry, for a command that does bayma's work, as the environment
 * configures it. It starts before the payload's environment, which REPL
 * sessions run with and which leaves telemetry settings out, is applied.
 */
async function startCommandTelemetry(): Promise<void> {
  await startTelemetry({
    "service.name": "bayma",
    "service.version": BAYMA_VERSION,
    "service.instance.id": randomUUID(),
  });
}

/** Tells the operator how installing the toolbelt goes, on stderr. */
function reportInstall(message: string): void {
  report(message, {}, SeverityNumber.INFO);
}

/**
 * Serve from the payload, with its environment, while its toolbelt installs
 * in the background: a server answers its clients at once, however long the
 * copy takes, and stops the install as it shuts down, or as it fails to
 * start.
 */
async function serveInstallingToolbelt(
  serve: (toolbelt: ToolbeltInstall) => Promise<never>,
): Promise<never> {
  const payload = requirePayloadDir();
  const toolbelt = startToolbeltInstall(payload, process.env, reportInstall);
  applyPayloadEnvironment(payload);
  try {
    return await serve(toolbelt);
  } catch (error) {
    await toolbelt.stop();
    throw error;
  }
}

export async function runCli(
  adapters: readonly RuntimeAdapter[],
): Promise<void> {
  try {
    await runCommand(adapters);
  } catch (error) {
    log(SeverityNumber.ERROR, failureDetail(error));
    throw error;
  } finally {
    await stopTelemetry();
  }
}

async function runCommand(adapters: readonly RuntimeAdapter[]): Promise<void> {
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
      const config = serverConfig(parseCliOptions(args, SERVER_OPTIONS));
      await startCommandTelemetry();
      await serveInstallingToolbelt((toolbelt) =>
        serveMcpStdio(adapters, { ...config, toolbelt }),
      );
      return;
    }
    case "mcp-http": {
      const parsed = parseCliOptions(args, [
        "--host",
        "--port",
        "--path",
        "--client-idle-timeout-ms",
        "--token-file",
        ...SERVER_OPTIONS,
      ]);
      const tokenFile = parsed.get("--token-file");
      await startCommandTelemetry();
      await serveInstallingToolbelt((toolbelt) =>
        serveMcpHttp(adapters, {
          host: option(parsed, "--host", "127.0.0.1"),
          port: Number(option(parsed, "--port", "7290")),
          path: option(parsed, "--path", "/mcp"),
          // A client that exits without ending its MCP session, as Claude Code
          // does, leaves the session behind; this closes it. Its leases are
          // open to takeover well before, so the timeout only bounds how long
          // an abandoned session is kept, and five minutes spares a client
          // that holds no stream open its MCP session across ordinary pauses.
          clientIdleTimeoutMs: Number(
            option(parsed, "--client-idle-timeout-ms", "300000"),
          ),
          // The token is read from a file so it stays out of the process's
          // arguments and environment, which other processes can read.
          bearerToken:
            tokenFile === undefined
              ? undefined
              : readFileSync(tokenFile, "utf8").trimEnd(),
          ...serverConfig(parsed),
          toolbelt,
        }),
      );
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
      await startCommandTelemetry();
      const payload = requirePayloadDir();
      // Unlike a server, doctor finishes with the toolbelt installed, so an
      // image built by running it carries the toolbelt in place.
      await installToolbelt(payload, process.env, reportInstall);
      applyPayloadEnvironment(payload);
      await runDoctor(selected, {
        cwd: option(parsed, "--cwd", process.cwd()),
        stateDir: parsed.get("--state-dir"),
        outputFormat,
      });
      return;
    }
    case "install-toolbelt": {
      parseCliOptions(args, []);
      await startCommandTelemetry();
      const payload = requirePayloadDir();
      let installed: boolean;
      try {
        installed = await installToolbelt(payload, process.env, reportInstall);
      } catch (error) {
        throw new Error(
          `installing the toolbelt at ${toolbeltPath()} failed: ${failureMessage(error)}`,
          { cause: error },
        );
      }
      if (!installed)
        reportInstall(`bayma: the toolbelt at ${toolbeltPath()} is current`);
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
