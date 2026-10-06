import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LaunchCommand,
  MCP_CLIENTS,
  registrationProblem,
} from "./clients.ts";
import { connectDocker, type Context, say } from "./context.ts";
import { type BaymaImage, baymaImage, missingImage } from "./image.ts";
import {
  cliRoot,
  pathEnvironment,
  TOOLBELT_VERSION_FILE,
  toolbeltDir,
} from "./paths.ts";
import { VERSION } from "./release.ts";

// What is set up of bayma here, and what of it would not work.

export interface Status {
  version: string;
  /** Docker's version, or why it could not be reached. */
  docker: { socket?: string; version?: string; problem?: string };
  /** The image this command runs, whether Docker has it, or why not known. */
  image: { image?: BaymaImage; present?: boolean; problem?: string };
  toolbelt: { path: string; version?: string };
  /** The versions of this command installed for MCP clients. */
  installed: string[];
  registrations: {
    client: string;
    launch?: LaunchCommand;
    problem?: string;
  }[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function readStatus(context: Context): Promise<Status> {
  const paths = pathEnvironment(context.home, context.env);
  const status: Status = {
    version: VERSION,
    docker: {},
    image: {},
    toolbelt: { path: toolbeltDir(paths) },
    installed: existsSync(cliRoot(paths))
      ? readdirSync(cliRoot(paths)).sort()
      : [],
    registrations: MCP_CLIENTS.map((client) => {
      const launch = client.registered(context.home, context.env);
      return {
        client: client.name,
        launch,
        problem: launch && registrationProblem(launch, context.env),
      };
    }),
  };
  const versionFile = join(status.toolbelt.path, TOOLBELT_VERSION_FILE);
  if (existsSync(versionFile))
    status.toolbelt.version = readFileSync(versionFile, "utf8").trim();
  try {
    status.image.image = baymaImage(context.env);
  } catch (error) {
    status.image.problem = message(error);
  }
  try {
    const engine = connectDocker(context);
    status.docker.socket = engine.socketPath;
    status.docker.version = (await engine.version()).Version;
    if (status.image.image !== undefined)
      status.image.present =
        (await engine.inspectImage(status.image.image.reference)) !== null;
  } catch (error) {
    status.docker.problem = message(error);
  }
  return status;
}

export function renderStatus(status: Status): string {
  const lines = [`bayma ${status.version}`];
  lines.push(
    status.docker.problem === undefined
      ? `Docker: ${status.docker.version} at ${status.docker.socket}`
      : `Docker: ${status.docker.problem}`,
  );
  const { image, present, problem } = status.image;
  lines.push(
    image === undefined
      ? `image: ${problem}`
      : present === undefined
        ? `image: ${image.reference}, not known to be here without Docker`
        : present
          ? `image: ${image.reference}`
          : `image: ${missingImage(image)}`,
  );
  lines.push(
    status.toolbelt.version === undefined
      ? `toolbelt: not installed at ${status.toolbelt.path}`
      : `toolbelt: ${status.toolbelt.version} at ${status.toolbelt.path}`,
  );
  lines.push(
    `installed for MCP clients: ${status.installed.length > 0 ? status.installed.join(", ") : "none"}`,
  );
  for (const { client, launch, problem } of status.registrations) {
    if (launch === undefined) {
      lines.push(`${client}: bayma is not registered`);
      continue;
    }
    const command = [launch.command, ...launch.args].join(" ");
    lines.push(
      problem === undefined
        ? `${client}: ${command}`
        : `${client}: ${command}, which is broken: ${problem}; npx bayma-repl init registers bayma again`,
    );
  }
  return lines.join("\n");
}

export async function showStatus(context: Context): Promise<number> {
  say(context, renderStatus(await readStatus(context)));
  return 0;
}
