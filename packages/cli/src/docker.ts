import { existsSync } from "node:fs";
import {
  type ClientRequest,
  type IncomingMessage,
  request as httpRequest,
  STATUS_CODES,
} from "node:http";
import type { Socket } from "node:net";
import { buffer } from "node:stream/consumers";

// Docker's Engine API, over the Unix socket Docker listens on: as much of it
// as pulling bayma's image and running it takes, called with node:http, so
// neither the docker command nor a client library is needed. Paths are those
// of API version 1.44 (Docker 25), the oldest Docker 29 still serves.
//
// The socket is the one DOCKER_HOST names (unix://PATH), /var/run/docker.sock
// when it names none.

const API_VERSION = "v1.44";
export const DEFAULT_SOCKET = "/var/run/docker.sock";

/** Docker refused a call, or could not be reached, saying why. */
export class DockerError extends Error {
  /** Docker's HTTP status, when it answered: 404 for absent, 409 for a conflict. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

/** The socket of the Docker `env` names, by DOCKER_HOST. */
export function dockerSocket(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const host = env.DOCKER_HOST;
  if (!host) return DEFAULT_SOCKET;
  if (host.startsWith("unix://")) return host.slice("unix://".length);
  throw new DockerError(
    `DOCKER_HOST is ${host}, but bayma reaches Docker only over a Unix socket: set it to unix://PATH, or unset it for ${DEFAULT_SOCKET}`,
  );
}

/** Why the Engine at `socketPath` could not be reached, and what to do. */
export function unreachableReason(
  socketPath: string,
  cause: NodeJS.ErrnoException,
): string {
  switch (cause.code) {
    case "EACCES":
    case "EPERM":
      return `A Docker Engine runs here, but only root and the docker group may use ${socketPath}: add yourself, with sudo usermod -aG docker $USER, and sign in again`;
    case "ECONNREFUSED":
      return `Nothing answers on ${socketPath}: start Docker, with sudo systemctl start docker`;
    case "ENOENT":
      return existsSync("/etc/debian_version")
        ? `No Docker Engine runs here (${socketPath} is missing): install one, with sudo apt-get install -y docker.io && sudo usermod -aG docker $USER, and sign in again; or set DOCKER_HOST to unix://PATH of the one you run`
        : `No Docker Engine runs here (${socketPath} is missing): install one, as https://docs.docker.com/engine/install/ describes; or set DOCKER_HOST to unix://PATH of the one you run`;
    default:
      return `Docker could not be reached at ${socketPath}: ${cause.message}`;
  }
}

/** What is read of Docker's version. */
export interface DockerVersion {
  Version: string;
  ApiVersion: string;
}

/** What is read of an image, inspected or listed. */
export interface ImageSummary {
  Id: string;
  RepoTags: string[] | null;
  RepoDigests: string[] | null;
}

/** What is read of a container, listed. */
export interface ContainerSummary {
  Id: string;
  Image: string;
  State: string;
}

/** A container as `createContainer` makes it: as much of the Engine API's body as bayma sets. */
export interface ContainerCreate {
  Image: string;
  Cmd: string[];
  User: string;
  Env: string[];
  WorkingDir: string;
  AttachStdin: boolean;
  AttachStdout: true;
  AttachStderr: true;
  OpenStdin: boolean;
  StdinOnce: boolean;
  Tty: false;
  HostConfig: {
    AutoRemove: true;
    Binds: string[];
    CapAdd: string[];
    SecurityOpt: string[];
    NetworkMode: "host";
  };
}

/** A line of a pull's progress, as Docker reports it. */
export interface PullEvent {
  status?: string;
  /** The layer it concerns, when it concerns one. */
  id?: string;
  progressDetail?: { current?: number; total?: number };
  error?: string;
}

/** A container being watched: the status it exits with, once it is gone. */
export interface ContainerExit {
  status: Promise<number>;
}

interface Call {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

function describe(call: Call): string {
  return `${call.method} ${call.path}`;
}

/** Docker's Engine API on the Unix socket `socketPath`. */
export class DockerEngine {
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  private send(call: Call): ClientRequest {
    const query = new URLSearchParams(call.query);
    const body =
      call.body === undefined ? undefined : JSON.stringify(call.body);
    const request = httpRequest({
      socketPath: this.socketPath,
      // A connection of its own for each call: a hijacked one leaves the
      // pool, and a pooled one would outlive the command.
      agent: false,
      method: call.method,
      path: `/${API_VERSION}${call.path}${query.size ? `?${query}` : ""}`,
      headers:
        body === undefined
          ? call.headers
          : {
              ...call.headers,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
    });
    request.end(body);
    return request;
  }

  private unreachable(call: Call, cause: unknown): DockerError {
    const errno = cause as NodeJS.ErrnoException;
    return new DockerError(
      errno.code
        ? unreachableReason(this.socketPath, errno)
        : `Docker failed ${describe(call)}: ${errno.message ?? String(cause)}`,
    );
  }

  /** Docker's refusal of `call`: its status, and the message its body holds. */
  private async refusal(
    call: Call,
    response: IncomingMessage,
  ): Promise<DockerError> {
    const status = response.statusCode ?? 0;
    const text = (await buffer(response)).toString("utf8").trim();
    let reason = text || STATUS_CODES[status] || "no message";
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") reason = parsed.message;
    } catch {
      // Not JSON: the text is the message.
    }
    return new DockerError(
      `Docker answered ${status} to ${describe(call)}: ${reason}`,
      status,
    );
  }

  /** The response to `call`; a status of 400 or over is its refusal. */
  private open(call: Call): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = this.send(call);
      request.on("response", (response) => {
        if ((response.statusCode ?? 0) < 400) resolve(response);
        else this.refusal(call, response).then(reject, reject);
      });
      request.on("error", (cause) => reject(this.unreachable(call, cause)));
    });
  }

  private async body(call: Call): Promise<Buffer> {
    const response = await this.open(call);
    try {
      return await buffer(response);
    } catch (cause) {
      throw this.unreachable(call, cause);
    }
  }

  private async json<T>(call: Call): Promise<T> {
    return JSON.parse((await this.body(call)).toString("utf8")) as T;
  }

  version(): Promise<DockerVersion> {
    return this.json({ method: "GET", path: "/version" });
  }

  /** The image, or null when Docker has none of `reference`. */
  async inspectImage(reference: string): Promise<ImageSummary | null> {
    try {
      // A reference as it is: the route takes its slashes, colons, and @.
      return await this.json({
        method: "GET",
        path: `/images/${reference}/json`,
      });
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null;
      throw error;
    }
  }

  listImages(): Promise<ImageSummary[]> {
    return this.json({ method: "GET", path: "/images/json" });
  }

  /**
   * Pulls `repository` at `tag`, a tag or a digest, from a registry that asks
   * for no login, telling `onEvent` of its progress as it goes.
   */
  async pullImage(
    repository: string,
    tag: string,
    onEvent: (event: PullEvent) => void,
  ): Promise<void> {
    const call: Call = {
      method: "POST",
      path: "/images/create",
      query: { fromImage: repository, tag },
    };
    const response = await this.open(call);
    // A pull that fails once it has begun still answers 200: its progress,
    // one JSON object a line, ends with the error.
    let pending = "";
    let failure: string | undefined;
    response.setEncoding("utf8");
    try {
      for await (const chunk of response) {
        pending += chunk as string;
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as PullEvent;
          if (event.error) failure = event.error;
          else onEvent(event);
        }
      }
    } catch (cause) {
      throw this.unreachable(call, cause);
    }
    if (failure !== undefined)
      throw new DockerError(`Docker could not pull ${repository}: ${failure}`);
  }

  /** Removes the reference `reference`, and the image with its last; one already gone is not an error. */
  async removeImage(reference: string): Promise<void> {
    try {
      await this.body({ method: "DELETE", path: `/images/${reference}` });
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
  }

  /** The containers, running or not, of the image `ancestor`. */
  listContainers(ancestor: string): Promise<ContainerSummary[]> {
    return this.json({
      method: "GET",
      path: "/containers/json",
      query: { all: "true", filters: JSON.stringify({ ancestor: [ancestor] }) },
    });
  }

  /** Makes the container; its id. */
  async createContainer(spec: ContainerCreate): Promise<string> {
    const { Id } = await this.json<{ Id: string }>({
      method: "POST",
      path: "/containers/create",
      body: spec,
    });
    return Id;
  }

  /**
   * Attaches to the container's streams, its stdin too when `stdin`. Docker
   * upgrades the connection to a raw stream: what the container writes comes
   * in frames (see `demultiplexer`), what is written goes to its stdin, and
   * ending the socket's writing half ends its stdin.
   */
  attachContainer(id: string, stdin: boolean): Promise<Socket> {
    const call: Call = {
      method: "POST",
      path: `/containers/${id}/attach`,
      query: {
        stream: "1",
        stdin: stdin ? "1" : "0",
        stdout: "1",
        stderr: "1",
      },
      headers: { Connection: "Upgrade", Upgrade: "tcp" },
    };
    return new Promise((resolve, reject) => {
      const request = this.send(call);
      request.on("upgrade", (_response, socket: Socket, head: Buffer) => {
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      // A daemon that answers without upgrading refused.
      request.on("response", (response) =>
        this.refusal(call, response).then(reject, reject),
      );
      request.on("error", (cause) => reject(this.unreachable(call, cause)));
    });
  }

  /**
   * Watches for the container to exit and be removed, as an auto-removed
   * container is. Docker is watching once this resolves, so the container
   * can be started without its exit going unseen.
   */
  watchExit(id: string): Promise<ContainerExit> {
    const call: Call = {
      method: "POST",
      path: `/containers/${id}/wait`,
      query: { condition: "removed" },
    };
    // Docker answers with its headers as soon as it is watching, and with
    // the body once the container is gone.
    return this.open(call).then((response) => ({
      status: buffer(response).then(
        (body) => {
          const { StatusCode, Error: error } = JSON.parse(
            body.toString("utf8"),
          ) as { StatusCode: number; Error?: { Message: string } | null };
          if (error?.Message)
            throw new DockerError(
              `Docker lost track of the container: ${error.Message}`,
            );
          return StatusCode;
        },
        (cause: unknown) => {
          throw this.unreachable(call, cause);
        },
      ),
    }));
  }

  async startContainer(id: string): Promise<void> {
    await this.body({ method: "POST", path: `/containers/${id}/start` });
  }

  /** Sends `signal` to the container; one no longer running is not an error. */
  async killContainer(id: string, signal: string): Promise<void> {
    try {
      await this.body({
        method: "POST",
        path: `/containers/${id}/kill`,
        query: { signal },
      });
    } catch (error) {
      if (!(error instanceof DockerError && [404, 409].includes(error.status!)))
        throw error;
    }
  }

  /** Removes the container, running or not; one already gone is not an error. */
  async removeContainer(id: string): Promise<void> {
    try {
      await this.body({
        method: "DELETE",
        path: `/containers/${id}`,
        query: { force: "true" },
      });
    } catch (error) {
      if (!(error instanceof DockerError && error.status === 404)) throw error;
    }
  }
}

/** A frame of an attached container's output: the stream it is of, and what was written. */
export interface Frame {
  stream: "stdout" | "stderr";
  data: Buffer;
}

/**
 * What a container without a terminal writes, out of the frames Docker sends
 * it in: an 8-byte header, the stream at byte 0 (1 for stdout, 2 for stderr)
 * and the size, big-endian, at byte 4, then what was written. A frame may
 * arrive across chunks, so what is left of one waits for the next.
 */
export function demultiplexer(): (chunk: Buffer) => Frame[] {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    const frames: Frame[] = [];
    let offset = 0;
    while (offset + 8 <= pending.length) {
      const size = pending.readUInt32BE(offset + 4);
      if (offset + 8 + size > pending.length) break;
      frames.push({
        stream: pending[offset] === 2 ? "stderr" : "stdout",
        data: pending.subarray(offset + 8, offset + 8 + size),
      });
      offset += 8 + size;
    }
    pending = pending.subarray(offset);
    return frames;
  };
}
