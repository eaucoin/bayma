import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContainerCreate,
  ImageSummary,
} from "../../packages/cli/src/docker.ts";

// A Docker Engine API on a temporary Unix socket, for the bayma command's
// tests: as much of the API as the command calls, answered over raw sockets
// as Docker answers them, attach's hijacked stream and its half-close
// included. Its containers echo their stdin to stdout, say they started on
// stderr, and exit when their stdin ends or they are killed.

/** A request the engine received. */
export interface EngineRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface FakeContainer {
  id: string;
  spec: ContainerCreate;
  started: boolean;
  removed: boolean;
  signals: string[];
  stdin: string;
}

export interface FakeEngineOptions {
  /** Images Docker has, by every reference that names them. */
  images?: Record<string, ImageSummary>;
  /** The lines a pull answers with, after its status. */
  pull?: { status: number; lines: string[] };
  /** The status a container exits with when its stdin ends, or, without stdin, once started; by its command, when a function. */
  exitStatus?: number | ((command: string) => number);
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};

function frame(stream: 1 | 2, text: string): Buffer {
  const data = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function respond(
  socket: Socket,
  status: number,
  body?: unknown,
  keepOpen = false,
): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${status} Fake\r\nContent-Type: application/json\r\n${keepOpen ? "" : `Content-Length: ${Buffer.byteLength(text)}\r\n`}Connection: close\r\n\r\n`,
  );
  if (!keepOpen) socket.end(text);
}

export class FakeDockerEngine {
  readonly socketPath: string;
  readonly requests: EngineRequest[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly removedImages: string[] = [];
  private readonly directory: string;
  private readonly server: Server;
  private readonly options: FakeEngineOptions;
  /** What exits each container: its attach socket closing, then its wait answering. */
  private readonly exits = new Map<string, (status: number) => void>();
  private readonly attached = new Map<string, Socket>();
  private readonly waiting = new Map<string, Socket[]>();

  private constructor(options: FakeEngineOptions) {
    this.options = options;
    this.directory = mkdtempSync(join(tmpdir(), "bayma-engine-"));
    this.socketPath = join(this.directory, "docker.sock");
    this.server = createServer({ allowHalfOpen: true }, (socket) =>
      this.accept(socket),
    );
  }

  static async start(
    options: FakeEngineOptions = {},
  ): Promise<FakeDockerEngine> {
    const engine = new FakeDockerEngine(options);
    await new Promise<void>((resolve) =>
      engine.server.listen(engine.socketPath, resolve),
    );
    return engine;
  }

  async close(): Promise<void> {
    for (const socket of this.attached.values()) socket.destroy();
    for (const sockets of this.waiting.values())
      for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    rmSync(this.directory, { recursive: true, force: true });
  }

  /** Requests to `method` paths that start with `prefix`. */
  calls(method: string, prefix: string): EngineRequest[] {
    return this.requests.filter(
      (request) => request.method === method && request.path.startsWith(prefix),
    );
  }

  private accept(socket: Socket): void {
    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = pending.subarray(0, end).toString("utf8").split("\r\n");
      const length = Number(
        /^content-length:\s*(\d+)$/im.exec(head.join("\n"))?.[1] ?? 0,
      );
      if (pending.length < end + 4 + length) return;
      socket.off("data", onData);
      const [method = "", target = ""] = head[0]!.split(" ");
      const url = new URL(target, "http://docker");
      const text = pending.subarray(end + 4, end + 4 + length).toString("utf8");
      const request: EngineRequest = {
        method,
        path: decodeURIComponent(url.pathname.replace(/^\/v1\.44/, "")),
        query: Object.fromEntries(url.searchParams),
        body: text ? JSON.parse(text) : undefined,
      };
      this.requests.push(request);
      this.handle(request, socket);
    };
    socket.on("data", onData);
    socket.on("error", () => undefined);
  }

  private handle(request: EngineRequest, socket: Socket): void {
    const { method, path } = request;
    const container = /^\/containers\/([^/]+)\/(\w+)$/.exec(path);
    const images = this.options.images ?? {};
    if (method === "GET" && path === "/version")
      return respond(socket, 200, { Version: "29.0.0", ApiVersion: "1.52" });
    if (method === "GET" && path === "/images/json")
      return respond(socket, 200, [...new Set(Object.values(images))]);
    if (method === "GET" && path.startsWith("/images/")) {
      const image = images[path.slice("/images/".length, -"/json".length)];
      return image
        ? respond(socket, 200, image)
        : respond(socket, 404, { message: "No such image" });
    }
    if (method === "DELETE" && path.startsWith("/images/")) {
      this.removedImages.push(path.slice("/images/".length));
      return respond(socket, 200, []);
    }
    if (method === "POST" && path === "/images/create") {
      const { status, lines } = this.options.pull ?? { status: 200, lines: [] };
      respond(socket, status, undefined, true);
      socket.end(lines.map((line) => `${line}\r\n`).join(""));
      return;
    }
    if (method === "GET" && path === "/containers/json")
      return respond(
        socket,
        200,
        [...this.containers.values()]
          .filter((each) => each.started && !each.removed)
          .map(({ id, spec }) => ({
            Id: id,
            Image: spec.Image,
            State: "running",
          })),
      );
    if (method === "POST" && path === "/containers/create") {
      const spec = request.body as ContainerCreate;
      if (!images[spec.Image])
        return respond(socket, 404, {
          message: `No such image: ${spec.Image}`,
        });
      const id = `container${this.containers.size + 1}`;
      this.containers.set(id, {
        id,
        spec,
        started: false,
        removed: false,
        signals: [],
        stdin: "",
      });
      return respond(socket, 201, { Id: id, Warnings: [] });
    }
    if (method === "DELETE" && path.startsWith("/containers/")) {
      const found = this.containers.get(path.slice("/containers/".length));
      if (!found) return respond(socket, 404, { message: "No such container" });
      found.removed = true;
      return respond(socket, 204);
    }
    const found = container && this.containers.get(container[1]!);
    if (!found) return respond(socket, 404, { message: "No such container" });
    switch (container![2]) {
      case "attach":
        return this.attach(found, socket);
      case "wait": {
        respond(socket, 200, undefined, true);
        this.waiting.set(found.id, [
          ...(this.waiting.get(found.id) ?? []),
          socket,
        ]);
        return;
      }
      case "start":
        found.started = true;
        respond(socket, 204);
        this.attached.get(found.id)?.write(frame(2, "started\n"));
        // Without stdin, it has nothing to wait for.
        if (!found.spec.OpenStdin)
          this.exits.get(found.id)?.(this.exitStatus(found));
        return;
      case "kill": {
        const signal = request.query.signal ?? "SIGKILL";
        found.signals.push(signal);
        respond(socket, 204);
        this.exits.get(found.id)?.(128 + (SIGNAL_NUMBERS[signal] ?? 9));
        return;
      }
    }
    respond(socket, 404, { message: `no route ${method} ${path}` });
  }

  private exitStatus(container: FakeContainer): number {
    const { exitStatus = 0 } = this.options;
    return typeof exitStatus === "number"
      ? exitStatus
      : exitStatus(container.spec.Cmd[0]!);
  }

  private attach(container: FakeContainer, socket: Socket): void {
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.multiplexed-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    this.attached.set(container.id, socket);
    const exit = (status: number) => {
      if (container.removed) return;
      this.exits.delete(container.id);
      socket.end();
      // An auto-removed container is gone once it has exited.
      container.removed = true;
      for (const waiter of this.waiting.get(container.id) ?? [])
        waiter.end(JSON.stringify({ StatusCode: status, Error: null }));
    };
    this.exits.set(container.id, exit);
    socket.on("data", (chunk: Buffer) => {
      container.stdin += chunk.toString("utf8");
      socket.write(frame(1, chunk.toString("utf8")));
    });
    socket.on("end", () => exit(this.exitStatus(container)));
  }
}
