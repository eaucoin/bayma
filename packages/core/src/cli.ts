import { randomUUID } from "node:crypto";
import type { RuntimeAdapter } from "./runtime/adapter.ts";
import { parseRuntimeId, RUNTIME_IDS, type RuntimeId } from "./runtime/id.ts";
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
import {
  parseSandboxHookMode,
  runSandboxHook,
  SANDBOX_HOOK_MODE_VARIABLE,
  SANDBOX_STOP_REASON_VARIABLE,
} from "./mcp/sandbox-hook.ts";
import { serveMcpStdio } from "./mcp/stdio.ts";
import { defaultStateDir } from "./paths.ts";
import { readTokenFile } from "./token-file.ts";
import { failureDetail, failureMessage } from "./errors.ts";
import { startTelemetry, stopTelemetry } from "./telemetry/index.ts";
import { log, report, SeverityNumber } from "./telemetry/record.ts";
import { BAYMA_VERSION } from "./version.ts";
import type { DurabilityMode } from "./session/model.ts";
import {
  DEFAULT_RUNTIME_MEMORY_BUDGET_BYTES,
  MEMORY_KILLS_APART_MS,
  type RuntimeMemoryBudget,
} from "./session/session-manager.ts";

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

/**
 * The runtime memory budget `spec` gives, as --runtime-memory-budget-mb takes
 * it in MiB: a list, each item a budget for the runtimes that keep something
 * of each cell (N), for every runtime (all=N), or for one (RUNTIME=N), 0 for
 * none.
 */
export function parseRuntimeMemoryBudget(spec: string): RuntimeMemoryBudget {
  const budget: RuntimeMemoryBudget = {};
  const runtimes: Partial<Record<RuntimeId, number>> = {};
  for (const item of spec.split(",")) {
    const match = /^(?:([a-z-]+)=)?(\d+)$/.exec(item.trim());
    const bytes = Number(match?.[2]) * 1024 ** 2;
    if (!match || !Number.isSafeInteger(bytes)) {
      throw new Error(
        `--runtime-memory-budget-mb takes a list of whole numbers of MiB, each alone, as all=N, or as RUNTIME=N, not ${JSON.stringify(item)}`,
      );
    }
    const named = match[1];
    if (named === undefined) budget.keeping = bytes;
    else if (named === "all") budget.all = bytes;
    else runtimes[parseRuntimeId(named)] = bytes;
  }
  return Object.keys(runtimes).length > 0 ? { ...budget, runtimes } : budget;
}

const SERVER_OPTIONS = [
  "--state-dir",
  "--max-sessions",
  "--warn-usage-percent",
  "--snapshot-token-limit",
  "--cols",
  "--rows",
  "--default-durability",
  "--runtime-memory-budget-mb",
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
    runtimeMemoryBudget: parseRuntimeMemoryBudget(
      option(
        parsed,
        "--runtime-memory-budget-mb",
        String(DEFAULT_RUNTIME_MEMORY_BUDGET_BYTES / 1024 ** 2),
      ),
    ),
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
      [--runtime-memory-budget-mb N]
      serve MCP over stdio
  mcp-http [--host HOST] [--port N] [--path PATH] [--state-dir PATH]
      [--max-sessions N] [--warn-usage-percent N]
      [--snapshot-token-limit N] [--cols N] [--rows N]
      [--default-durability checkpointed|ephemeral]
      [--runtime-memory-budget-mb N]
      [--client-idle-timeout-ms N] [--client-ping-ms N]
      [--token-file PATH] [--telemetry-token-file PATH] [--stop-wait-ms N]
      serve MCP over Streamable HTTP; a client session with no request or
      stream open for the idle timeout, five minutes unless given, is
      closed, as is one holding a stream open that answers no ping on it,
      sent every --client-ping-ms, 30 seconds unless given, within as long
      again; with --token-file, every request must carry the file's
      token as Authorization: Bearer, read again once its sandbox is
      restored, for its new host's token; with --telemetry-token-file,
      each export of its telemetry carries that file's token as its
      bearer, read for each export. GET /status answers, as JSON, how
      many execs are running and queued in every session (execsRunning,
      execsQueued), those running by their sessions' and their own IDs
      (running: sessionId, execId), when none is, since when
      (idleSinceMs), and the state generation (generation). With
      --stop-wait-ms, SIGTERM's stop is held for up to that long for a save
      of the sandbox, as a host that ends the sandbox's pod saves it whole
      first: meanwhile the server takes no new session and no new exec,
      those running or queued carrying on; a save that ends the sandbox
      ends the server with it, and a restore from that save lets the stop
      go, as its old pod's; a resume, sandbox-hook stop, or the wait's end
      goes on with the stop, a sandbox-hook stop asked while the server is
      saved once it runs on; one asked before SIGTERM, as a host asks it as
      it ends the pod itself, has the SIGTERM that follows within the wait
      stop the server at once. Without it, or with 0, SIGTERM stops the
      server at once
  sandbox-hook [save|restore|resume|stop] --state-dir PATH
      tell the server of the state directory that the sandbox it runs in
      is about to be saved whole, was restored, or runs on after a save, as
      a host that saves sandboxes runs it in the sandbox, or, with stop,
      that the stop it holds, or the next it is given, goes on (mcp-http
      --stop-wait-ms): gVisor's runsc
      checkpoint --save-restore-exec-argv, naming the mode in
      GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE. Saving puts what sessions
      committed on storage, holds requests, timeouts and exec starts, and
      pauses the toolbelt's install with none of its files open, until the
      restore or resume; it prints, as JSON, what the save caught: the
      state generation and the execs running (generation, running:
      sessionId, execId), which the state directory's last-save.json says
      too. A restore reads the token file again, starts clients' reconnect
      grace and idle timeouts again, tells each live session's next exec
      how it came back, and why the sandbox was stopped where
      BAYMA_SANDBOX_STOP_REASON says, as the end of a sentence ("it ran
      out of its memory (4Gi)"), and starts over the toolbelt's install
      that the save paused. A host whose save fails runs resume, and a
      save neither follows within ten minutes is given up on. A gVisor
      sandbox's file locks hold within it alone, so such a host runs one
      server per state directory.
      The state generation, in the state directory's generation.json as
      { "schemaVersion": 1, "generation": N }, is moved on, on the disk,
      before the server persists any change or tells a client of one as
      state: an exec submitted, started or ended, an interrupt or a host
      recycled, a session created, resized, recovered, scheduled for
      eviction, closed or quarantined, a checkpoint committed or failed, or
      the server started afresh. What is of clients' connections alone,
      controllers and observers joining, changing and leaving, and pressure
      warnings, which a restored server has again from its clients, does
      not move it, nor does an exec's output, which a restore may show
      again.
      A save left running may be restored only while the generation on the
      disk is the one the save caught: the server refuses a restore
      otherwise, and stays saved rather than write over what is newer,
      answering nothing more until its host kills it (SIGKILL), and
      a host checks it before it lets a restored sandbox run, refusing one
      whose file it cannot read or whose schemaVersion it does not know.
      Nothing is written into the state directory before the generation
      moves on, so a server whose generation is stale writes nothing there,
      but what a session's own host writes in its scratch directory, as a Go
      build that ends meanwhile, which a fresh start empties all the same. A
      fresh start finds generation.json of another schema, or none it can
      read, and writes it anew, said so, at a generation no save caught; a
      restore refuses it.
      A server stopped gracefully, as by SIGTERM, which a pod's deletion
      sends, persists its sessions as it stops, and so moves the generation
      on: a save of it left running is restored only where the server ended
      otherwise, as a lost pod's or node's does, killed. So that a save it
      matches has every file the sandbox maps, a Go session's host keeps
      each cell's plugin, 2 to 4 MB, in its scratch directory for as long as
      it runs; the server removes them once the generation is on the disk
      past the host's end, a recycle or a quarantine, or as the session is
      closed or the server starts afresh
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

The runtime memory budget, --runtime-memory-budget-mb, bounds what a
session's host comes to hold of its own, anonymous memory and swap across
its process group, past what it held as it started or was restored: once an
exec has ended, a host past it is started again from the session's
checkpoint, or afresh where none was committed, and the session's next exec
is told so, and why. By default it is ${DEFAULT_RUNTIME_MEMORY_BUDGET_BYTES / 1024 ** 2} MiB, and covers only C# and
Go, whose hosts keep every cell they compiled, each C# cell costing more the
longer the session runs, and every cell's plugin, so that they grow with
their cells. The option takes a list: N for those, all=N for every runtime,
RUNTIME=N for one, each in MiB, 0 for none, a runtime's own before all=N. A
host its checkpoint restores already past the budget would be started again
after every exec: the budget stands down for that session until it closes,
and its next exec is told so. A host the kernel kills as it runs out of the
memory of the cgroup bayma runs in is started again the same way, the exec
it ran ending in error, unless the kernel kills it so again within
${MEMORY_KILLS_APART_MS / 1_000} s, which quarantines its session.

OpenTelemetry traces, metrics, and logs of bayma's work are exported over
OTLP to wherever OTEL_EXPORTER_OTLP_ENDPOINT and OpenTelemetry's other
standard variables say; with none set, nothing is exported.`);
}

/**
 * Telemetry, for a command that does bayma's work, as the environment
 * configures it, with the token `bearerTokenFile` holds as its bearer if
 * given. It starts before the payload's environment, which REPL sessions run
 * with and which leaves telemetry settings out, is applied.
 */
async function startCommandTelemetry(bearerTokenFile?: string): Promise<void> {
  await startTelemetry(
    {
      "service.name": "bayma",
      "service.version": BAYMA_VERSION,
      "service.instance.id": randomUUID(),
    },
    bearerTokenFile,
  );
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
        "--client-ping-ms",
        "--token-file",
        "--telemetry-token-file",
        "--stop-wait-ms",
        ...SERVER_OPTIONS,
      ]);
      const telemetryTokenFile = parsed.get("--telemetry-token-file");
      // Read once now, so that a server never starts with a token it cannot
      // export with.
      if (telemetryTokenFile !== undefined)
        readTokenFile(telemetryTokenFile, "telemetry bearer token");
      await startCommandTelemetry(telemetryTokenFile);
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
          clientPingMs: Number(option(parsed, "--client-ping-ms", "30000")),
          tokenFile: parsed.get("--token-file"),
          stopWaitMs: Number(option(parsed, "--stop-wait-ms", "0")),
          ...serverConfig(parsed),
          toolbelt,
        }),
      );
      return;
    }
    case "sandbox-hook": {
      // gVisor runs the command with its mode in the environment, unless
      // the command names one first.
      const named = args.length % 2 === 1 ? args[0] : undefined;
      const parsed = parseCliOptions(
        named === undefined ? args : args.slice(1),
        ["--state-dir"],
      );
      // A host runs the hook from a directory of its own, such as the
      // sandbox's root, not the server's: the state directory is named.
      const stateDir = parsed.get("--state-dir");
      if (stateDir === undefined)
        throw new Error("sandbox-hook needs --state-dir, its server's");
      // The server records what the hook sets off; this process only asks
      // it to, so it exports no telemetry of its own.
      const mode = parseSandboxHookMode(
        named ?? process.env[SANDBOX_HOOK_MODE_VARIABLE],
      );
      const caught = await runSandboxHook(
        stateDir,
        mode,
        mode === "restore"
          ? process.env[SANDBOX_STOP_REASON_VARIABLE]
          : undefined,
      );
      if (caught !== undefined) console.log(caught);
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
