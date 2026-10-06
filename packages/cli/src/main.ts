import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { connectDocker, type Context } from "./context.ts";
import { baymaImage } from "./image.ts";
import { containerSpec, type ImageCommand, runContainer } from "./launcher.ts";
import { VERSION } from "./release.ts";
import { setUp } from "./setup.ts";
import { showStatus } from "./status.ts";
import { uninstall } from "./uninstall.ts";

// The `bayma` command of the npm package: it sets bayma up on this machine,
// and launches bayma's servers and doctor in bayma's image.

function usage(): string {
  return `Usage: npx bayma <command>

bayma is a durable engine for REPL sessions, served to agents by its MCP
servers. This command sets it up on Linux (x64) with Docker, and runs it in
bayma's image of its own version.

Commands:
  init
      pull bayma's image, install the toolbelt bundled with bayma, check
      each runtime with bayma's doctor, and register bayma with Claude Code
      and Codex, as an MCP server they launch over stdio
  upgrade
      set up this version of bayma in place of the one set up now; run it
      as npx bayma@latest upgrade
  status
      show what is set up of bayma here, and what of it would not work
  mcp-stdio [OPTIONS]
      serve MCP over stdio, as MCP clients launch bayma
  mcp-http [OPTIONS]
      serve MCP over Streamable HTTP, on this machine's own network
  doctor [OPTIONS]
      check that each runtime works here
  uninstall [--purge]
      remove bayma's registrations, its commands for MCP clients, its
      images, its toolbelt, and its cache; with --purge, REPL sessions'
      state too
  version
      print the version
  help
      show this help

OPTIONS are those of the same command in bayma's image, passed to it as
given. bayma's servers export OpenTelemetry traces, metrics, and logs where
the OTEL_* variables set here say.`;
}

/** The commands this one runs in bayma's image, as they are. */
const LAUNCHED: readonly string[] = [
  "mcp-stdio",
  "mcp-http",
  "doctor",
] satisfies ImageCommand[];

async function launch(
  context: Context,
  command: ImageCommand,
  args: string[],
): Promise<number> {
  const image = baymaImage(context.env);
  return runContainer(
    connectDocker(context),
    image,
    containerSpec(image.reference, command, args, context),
    context.stdio,
  );
}

/** Refuses any arguments beyond `allowed`. */
function expectArgs(command: string, args: string[], allowed: string[]): void {
  const unknown = args.find((arg) => !allowed.includes(arg));
  if (unknown !== undefined)
    throw new Error(`${command} takes no ${unknown}; see npx bayma help`);
}

/** This process's context: who runs it, from where, with what. */
function processContext(): Context {
  return {
    uid: process.getuid!(),
    gid: process.getgid!(),
    home: process.env.HOME || homedir(),
    cwd: process.cwd(),
    env: process.env,
    node: process.execPath,
    bundle: fileURLToPath(import.meta.url),
    stdio: {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    },
  };
}

async function run(argv: string[]): Promise<number> {
  const [command = "help", ...args] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command === "version" || command === "--version" || command === "-V") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  // bayma's image, and the payload of runtimes in it, are built for Linux on
  // x64 alone.
  const platform = `${process.platform}-${process.arch}`;
  if (platform !== "linux-x64")
    throw new Error(
      `bayma runs on Linux (x64) with Docker, and this is ${platform}`,
    );
  const context = processContext();
  if (LAUNCHED.includes(command))
    return launch(context, command as ImageCommand, args);
  switch (command) {
    case "init":
    case "upgrade":
      expectArgs(command, args, []);
      return setUp(context, command === "upgrade");
    case "status":
      expectArgs(command, args, []);
      return showStatus(context);
    case "uninstall":
      expectArgs(command, args, ["--purge"]);
      return uninstall(context, args.includes("--purge"));
    default:
      process.stderr.write(`${usage()}\n`);
      return 2;
  }
}

let status: number;
try {
  status = await run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `bayma: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  status = 1;
}
// A launched server's stdin is still open when the server is gone; nothing
// is left to do with it.
process.exit(status);
