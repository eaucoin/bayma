import { existsSync, readdirSync, rmSync } from "node:fs";
import { findExecutable, MCP_CLIENTS, runCommand } from "./clients.ts";
import { connectDocker, type Context, say } from "./context.ts";
import type { DockerEngine } from "./docker.ts";
import { IMAGE_OVERRIDE } from "./image.ts";
import { cacheRoot, dataRoot, pathEnvironment, stateRoot } from "./paths.ts";
import { IMAGE_REPOSITORY } from "./release.ts";

// Taking bayma off this machine: its registrations, the commands installed
// for MCP clients, the images of bayma this command pulled, the toolbelt,
// and bayma's cache; with --purge, REPL sessions' state too.

/** The references of bayma's images that bayma's commands pulled: by digest, from its repository. */
async function pulledImages(engine: DockerEngine): Promise<string[]> {
  return (await engine.listImages()).flatMap(({ RepoDigests }) =>
    (RepoDigests ?? []).filter((reference) =>
      reference.startsWith(`${IMAGE_REPOSITORY}@`),
    ),
  );
}

/** How many containers of `references` run now. */
async function running(
  engine: DockerEngine,
  references: readonly string[],
): Promise<number> {
  let count = 0;
  for (const reference of references)
    count += (await engine.listContainers(reference)).filter(
      ({ State }) => State === "running",
    ).length;
  return count;
}

function remove(context: Context, path: string, what: string): void {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  say(context, `removed ${what}, ${path}`);
}

export async function uninstall(
  context: Context,
  purge: boolean,
): Promise<number> {
  const paths = pathEnvironment(context.home, context.env);
  let docker: { engine: DockerEngine; images: string[] } | undefined;
  try {
    const engine = connectDocker(context);
    docker = { engine, images: await pulledImages(engine) };
  } catch (error) {
    say(
      context,
      `${error instanceof Error ? error.message : String(error)}; bayma's images are left as they are`,
    );
  }
  if (docker !== undefined) {
    const override = context.env[IMAGE_OVERRIDE];
    const servers = await running(
      docker.engine,
      override ? [...docker.images, override] : docker.images,
    );
    // A server running now would go on using what is removed, and write its
    // REPL sessions' state back as it shut down.
    if (servers > 0)
      throw new Error(
        `bayma runs in ${servers} container${servers === 1 ? "" : "s"} now, serving MCP clients: close them, then uninstall`,
      );
  }

  for (const client of MCP_CLIENTS) {
    const executable = findExecutable(client.executable, context.env);
    if (!executable) continue;
    const result = await runCommand(executable, client.remove, context.env);
    say(
      context,
      result.status === 0
        ? `${client.name}: removed bayma`
        : `${client.name}: removed nothing: ${result.output.trim()}`,
    );
  }

  if (docker !== undefined)
    for (const reference of docker.images) {
      await docker.engine.removeImage(reference);
      say(context, `removed the image ${reference}`);
    }
  // All of bayma's data directory is bayma's: beside the toolbelt and this
  // command's installs are the lock installs take and what a stopped one
  // left, so it goes whole.
  remove(
    context,
    dataRoot(paths),
    "the toolbelt bundled with bayma and bayma's commands for MCP clients",
  );
  remove(context, cacheRoot(paths), "bayma's cache");

  const state = stateRoot(paths);
  if (!existsSync(state)) return 0;
  if (!purge) {
    say(
      context,
      `kept REPL sessions' state, in ${state}; uninstall --purge removes it`,
    );
    return 0;
  }
  const directories = readdirSync(state).length;
  say(
    context,
    `removing REPL sessions' state, of the ${directories} director${directories === 1 ? "y" : "ies"} MCP clients launched bayma from: every REPL session's catalog entry, execution history, checkpoints, and process snapshots`,
  );
  remove(context, state, "REPL sessions' state");
  return 0;
}
