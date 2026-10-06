import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  findExecutable,
  type LaunchCommand,
  MCP_CLIENTS,
  register,
  SERVER_NAME,
} from "./clients.ts";
import { connectDocker, type Context, say } from "./context.ts";
import type { DockerEngine } from "./docker.ts";
import {
  type BaymaImage,
  baymaImage,
  ensureImage,
  pullReporter,
} from "./image.ts";
import { containerSpec, runContainer } from "./launcher.ts";
import {
  cliRoot,
  installedCli,
  type PathEnvironment,
  pathEnvironment,
} from "./paths.ts";
import { VERSION } from "./release.ts";

// Setting bayma up, or up again at another version: its image, the toolbelt
// bundled with it, its doctor's verdict, and this command installed where MCP
// clients launch it from, registered with those found here.

/** Copies this command's bundle to where MCP clients launch it from. */
export function installCli(paths: PathEnvironment, bundle: string): string {
  const target = installedCli(paths, VERSION);
  mkdirSync(dirname(target), { recursive: true });
  // Copied beside it and renamed into place, so a client starting now never
  // runs half of it.
  const staging = `${target}.${process.pid}`;
  copyFileSync(bundle, staging);
  chmodSync(staging, 0o755);
  renameSync(staging, target);
  return target;
}

/**
 * What MCP clients launch: the installed command, with the absolute path of
 * the node running this one. A client starts its servers with its own PATH,
 * which often lacks a node installed by a version manager; this node is
 * there now and new enough. If it goes, `bayma status` says so, and init
 * registers another.
 */
export function launchCommand(node: string, cli: string): LaunchCommand {
  return { command: node, args: [cli, "mcp-stdio"] };
}

/** The configuration any other MCP client takes. */
export function mcpServersJson(launch: LaunchCommand): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: launch } }, null, 2);
}

/** The versions of this command installed here, but this one. */
function otherVersions(paths: PathEnvironment): string[] {
  const root = cliRoot(paths);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((version) => version !== VERSION);
}

/** Runs one of the image's commands to its end, as the launcher would: its status. */
function runInImage(
  context: Context,
  engine: DockerEngine,
  image: BaymaImage,
  command: "install-toolbelt" | "doctor",
  output: Context["stdio"]["stdout"],
): Promise<number> {
  return runContainer(
    engine,
    image,
    containerSpec(image.reference, command, [], context),
    { ...context.stdio, stdout: output },
  );
}

/**
 * `init`, or `upgrade` when `upgrade`: sets bayma up at this version. It
 * fails when bayma cannot run here at all; a runtime the doctor finds broken
 * leaves the others to use, so bayma is registered all the same, with a
 * warning at the end.
 */
export async function setUp(
  context: Context,
  upgrade: boolean,
): Promise<number> {
  const paths = pathEnvironment(context.home, context.env);
  if (upgrade) {
    const others = otherVersions(paths);
    say(
      context,
      `Upgrading to bayma ${VERSION}${others.length > 0 ? ` from ${others.join(", ")}` : ""}. MCP clients running now keep their bayma until they restart; once they do, a REPL session another version snapshotted is restored from its checkpoints rather than resumed live, since a process snapshot is restored only by the version that took it.`,
    );
  }
  const image = baymaImage(context.env);
  const engine = connectDocker(context);
  const docker = await engine.version();
  say(context, `Docker ${docker.Version} answers at ${engine.socketPath}`);

  const progress = pullReporter(context.stdio.stderr);
  if (image.pinned)
    say(context, `pulling bayma ${VERSION}'s image, ${image.reference}`);
  const pulled = await ensureImage(engine, image, (event) =>
    progress.event(event),
  );
  progress.end();
  say(context, `image ${image.reference}: ${pulled}`);

  say(context, "installing the toolbelt bundled with bayma");
  const installed = await runInImage(
    context,
    engine,
    image,
    "install-toolbelt",
    context.stdio.stderr,
  );
  if (installed !== 0)
    throw new Error(
      `bayma install-toolbelt failed with status ${installed}, as it says above; bayma is not registered`,
    );
  say(context, "checking each runtime with bayma doctor");
  const doctor = await runInImage(
    context,
    engine,
    image,
    "doctor",
    context.stdio.stdout,
  );

  const cli = installCli(paths, context.bundle);
  say(context, `installed bayma ${VERSION} at ${cli}`);
  const launch = launchCommand(context.node, cli);
  let failed = false;
  for (const client of MCP_CLIENTS) {
    const executable = findExecutable(client.executable, context.env);
    if (!executable) {
      say(
        context,
        `${client.name}: no ${client.executable} on PATH, so not registered`,
      );
      continue;
    }
    const result = await register(client, executable, launch, context.env);
    const ran = [client.executable, ...client.add(launch)].join(" ");
    if (result.status === 0)
      say(context, `${client.name}: registered bayma, with ${ran}`);
    else {
      failed = true;
      say(
        context,
        `${client.name}: ${ran} failed with status ${result.status}: ${result.output.trim()}`,
      );
    }
  }
  say(context, `For any other MCP client:\n${mcpServersJson(launch)}`);
  if (doctor !== 0)
    say(
      context,
      `warning: bayma doctor failed with status ${doctor}, so a runtime its report above names as failing does not work here; bayma is registered all the same, for the runtimes that do. npx bayma-repl doctor checks them again.`,
    );
  return failed ? 1 : 0;
}
