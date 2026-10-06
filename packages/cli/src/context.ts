import { DockerEngine, dockerSocket } from "./docker.ts";
import type { Invocation, Stdio } from "./launcher.ts";

/** What a command runs with: who invoked it and from where, and its streams. */
export interface Context extends Invocation {
  /** The node running this command, which MCP clients are registered to launch it with. */
  node: string;
  /** This command's own bundle, which is installed for MCP clients to launch. */
  bundle: string;
  stdio: Stdio & { stdout: { isTTY?: boolean }; stderr: { isTTY?: boolean } };
}

/** The Docker the context's environment names. */
export function connectDocker(context: Context): DockerEngine {
  return new DockerEngine(dockerSocket(context.env));
}

/** Writes `text` and a newline to the context's stdout. */
export function say(context: Context, text: string): void {
  context.stdio.stdout.write(`${text}\n`);
}
