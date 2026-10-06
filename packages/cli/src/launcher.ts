import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  type ContainerCreate,
  type ContainerExit,
  demultiplexer,
  type DockerEngine,
  DockerError,
} from "./docker.ts";
import { type BaymaImage, missingImage } from "./image.ts";

// bayma's image, run as its servers and commands are: as the invoking user,
// with their home mounted at its own path and the directory they launched
// from as its working directory, on the machine's network, with the
// capabilities and seccomp profile CRIU needs to snapshot REPL sessions
// within the container, and removed once it exits. This command forwards its stdio and signals to the
// container and exits with its status, as `docker run -i --rm` would.

/** The image's commands this command runs. */
export type ImageCommand =
  "mcp-stdio" | "mcp-http" | "doctor" | "install-toolbelt";

/** Who runs the container, and from where. */
export interface Invocation {
  uid: number;
  gid: number;
  home: string;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** What lets bayma snapshot REPL sessions within its own container. */
const SNAPSHOT_CAPABILITIES = ["CHECKPOINT_RESTORE", "SYS_PTRACE"];
const SNAPSHOT_SECURITY = ["seccomp=unconfined"];

/**
 * OpenTelemetry's standard variables, those set: bayma exports its own
 * telemetry where they say (packages/core/src/telemetry/config.ts).
 */
function telemetryEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(env)
    .filter(([name, value]) => name.startsWith("OTEL_") && value)
    .map(([name, value]) => `${name}=${value}`)
    .sort();
}

/** The container that runs `command` of `image` with `args`, for `invocation`. */
export function containerSpec(
  image: string,
  command: ImageCommand,
  args: readonly string[],
  invocation: Invocation,
): ContainerCreate {
  // A stdio server reads its client on stdin, and shuts down when it ends.
  const stdin = command === "mcp-stdio";
  return {
    Image: image,
    Cmd: [command, ...args],
    User: `${invocation.uid}:${invocation.gid}`,
    Env: [`HOME=${invocation.home}`, ...telemetryEnvironment(invocation.env)],
    WorkingDir: invocation.cwd,
    AttachStdin: stdin,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: stdin,
    StdinOnce: stdin,
    Tty: false,
    HostConfig: {
      AutoRemove: true,
      Binds: [`${invocation.home}:${invocation.home}`],
      CapAdd: SNAPSHOT_CAPABILITIES,
      SecurityOpt: SNAPSHOT_SECURITY,
      // bayma runs as the user with their home mounted, so a network of its
      // own would isolate nothing; on the machine's, localhost is this
      // machine to REPL sessions and OTLP endpoints, and an HTTP server's
      // 127.0.0.1, its default, is this machine's loopback, with no port to
      // publish.
      NetworkMode: "host",
    },
  };
}

/** The streams a container's are forwarded to and from. */
export interface Stdio {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/** The signals forwarded to the container, which bayma shuts down on. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Runs the container `spec` describes, forwarding `stdio` and this process's
 * signals to it, until it has exited and been removed: its exit status.
 */
export async function runContainer(
  engine: DockerEngine,
  image: BaymaImage,
  spec: ContainerCreate,
  stdio: Stdio,
): Promise<number> {
  let id: string;
  try {
    id = await engine.createContainer(spec);
  } catch (error) {
    if (error instanceof DockerError && error.status === 404)
      throw new Error(missingImage(image));
    throw error;
  }
  let socket: Socket | undefined;
  let exit: ContainerExit | undefined;
  try {
    // Attached and watched before it starts, so none of its output, nor its
    // exit, is missed.
    socket = await engine.attachContainer(id, spec.OpenStdin);
    exit = await engine.watchExit(id);
    await engine.startContainer(id);
  } catch (error) {
    socket?.destroy();
    exit?.status.catch(() => undefined);
    // What is reported is why it did not start, not how removing it went.
    await engine.removeContainer(id).catch(() => undefined);
    throw error;
  }
  return forwardUntilExit(engine, id, socket, exit, spec.OpenStdin, stdio);
}

async function forwardUntilExit(
  engine: DockerEngine,
  id: string,
  socket: Socket,
  exit: ContainerExit,
  stdin: boolean,
  stdio: Stdio,
): Promise<number> {
  const forward = (signal: NodeJS.Signals) => {
    engine
      .killContainer(id, signal)
      .catch((error: unknown) =>
        stdio.stderr.write(
          `bayma: could not forward ${signal}: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);

  const frames = demultiplexer();
  const output = new Promise<void>((resolve) => {
    socket.on("data", (chunk: Buffer) => {
      for (const { stream, data } of frames(chunk)) {
        const target = stdio[stream];
        if (!target.write(data)) {
          socket.pause();
          target.once("drain", () => socket.resume());
        }
      }
    });
    // The container's exit status is the outcome; a connection that breaks
    // as it exits, as one written to after its stdin closed does, ends its
    // output no differently.
    socket.on("error", () => undefined);
    socket.on("close", () => resolve());
  });
  // Piping ends the socket's writing half when stdin ends, which closes the
  // container's stdin: a stdio server's signal to shut down.
  if (stdin) stdio.stdin.pipe(socket);
  try {
    const [status] = await Promise.all([exit.status, output]);
    return status;
  } finally {
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    if (stdin) stdio.stdin.unpipe(socket);
    socket.destroy();
  }
}
