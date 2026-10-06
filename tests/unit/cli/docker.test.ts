import { afterEach, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  demultiplexer,
  DockerEngine,
  DockerError,
  dockerSocket,
  type PullEvent,
} from "../../../packages/cli/src/docker.ts";
import { FakeDockerEngine } from "../../support/fake-docker-engine.ts";
import { withTempDir } from "../../support/temp.ts";

const IMAGE = {
  Id: "sha256:image",
  RepoTags: null,
  RepoDigests: ["ghcr.io/eaucoin/bayma@sha256:1234"],
};

const engines: FakeDockerEngine[] = [];

async function fakeEngine(
  ...options: Parameters<typeof FakeDockerEngine.start>
): Promise<{ fake: FakeDockerEngine; engine: DockerEngine }> {
  const fake = await FakeDockerEngine.start(...options);
  engines.push(fake);
  return { fake, engine: new DockerEngine(fake.socketPath) };
}

afterEach(async () => {
  for (const fake of engines.splice(0)) await fake.close();
});

test("Docker is reached over the Unix socket DOCKER_HOST names, or Docker's own", () => {
  expect(dockerSocket({})).toBe("/var/run/docker.sock");
  expect(dockerSocket({ DOCKER_HOST: "" })).toBe("/var/run/docker.sock");
  expect(
    dockerSocket({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" }),
  ).toBe("/run/user/1000/docker.sock");
  expect(() => dockerSocket({ DOCKER_HOST: "tcp://10.0.0.1:2376" })).toThrow(
    "DOCKER_HOST is tcp://10.0.0.1:2376, but bayma reaches Docker only over a Unix socket",
  );
});

test("an Engine that cannot be reached says why, and what to do", async () => {
  await withTempDir(async (directory) => {
    const missing = join(directory, "missing.sock");
    await expect(new DockerEngine(missing).version()).rejects.toThrow(
      `No Docker Engine runs here (${missing} is missing)`,
    );

    // A file that is no socket refuses connections, as a stopped daemon's
    // socket left behind does.
    const stale = join(directory, "stale.sock");
    writeFileSync(stale, "");
    await expect(new DockerEngine(stale).version()).rejects.toThrow(
      `Nothing answers on ${stale}: start Docker`,
    );

    const denied = join(directory, "denied.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(denied, resolve));
    try {
      chmodSync(denied, 0o000);
      await expect(new DockerEngine(denied).version()).rejects.toThrow(
        `only root and the docker group may use ${denied}: add yourself, with sudo usermod -aG docker $USER`,
      );
    } finally {
      server.close();
    }
  });
});

test("Docker's answers are read, and its refusals carry its status and message", async () => {
  const { fake, engine } = await fakeEngine({
    images: { "ghcr.io/eaucoin/bayma@sha256:1234": IMAGE },
  });
  expect((await engine.version()).Version).toBe("29.0.0");
  expect(
    await engine.inspectImage("ghcr.io/eaucoin/bayma@sha256:1234"),
  ).toEqual(IMAGE);
  expect(await engine.inspectImage("bayma:0.0.0")).toBeNull();
  expect(fake.calls("GET", "/images/").map(({ path }) => path)).toEqual([
    "/images/ghcr.io/eaucoin/bayma@sha256:1234/json",
    "/images/bayma:0.0.0/json",
  ]);
  const refused = await engine
    .startContainer("nothing")
    .catch((error) => error);
  expect(refused).toBeInstanceOf(DockerError);
  expect(refused.status).toBe(404);
  expect(refused.message).toBe(
    "Docker answered 404 to POST /containers/nothing/start: No such container",
  );
});

test("a pull reports its progress, line by line, and fails with the error it ends with", async () => {
  const progress = [
    { status: "Pulling from eaucoin/bayma", id: "sha256:1234" },
    {
      status: "Downloading",
      id: "a",
      progressDetail: { current: 5, total: 10 },
    },
    { status: "Pull complete", id: "a" },
  ];
  const { fake, engine } = await fakeEngine({
    pull: { status: 200, lines: progress.map((line) => JSON.stringify(line)) },
  });
  const events: PullEvent[] = [];
  await engine.pullImage("ghcr.io/eaucoin/bayma", "sha256:1234", (event) =>
    events.push(event),
  );
  expect(events).toEqual(progress);
  expect(fake.calls("POST", "/images/create")[0]!.query).toEqual({
    fromImage: "ghcr.io/eaucoin/bayma",
    tag: "sha256:1234",
  });

  const failing = await fakeEngine({
    pull: {
      status: 200,
      lines: [
        JSON.stringify(progress[0]),
        JSON.stringify({
          error: "manifest unknown",
          errorDetail: { message: "manifest unknown" },
        }),
      ],
    },
  });
  await expect(
    failing.engine.pullImage(
      "ghcr.io/eaucoin/bayma",
      "sha256:1234",
      () => undefined,
    ),
  ).rejects.toThrow(
    "Docker could not pull ghcr.io/eaucoin/bayma: manifest unknown",
  );
});

test("a container is created, attached, watched, and started; its stdin half-closes, and it exits and is gone", async () => {
  const { fake, engine } = await fakeEngine({
    images: { "bayma:0.0.0": IMAGE },
    exitStatus: 3,
  });
  const id = await engine.createContainer({
    Image: "bayma:0.0.0",
    Cmd: ["mcp-stdio"],
    User: "1000:1000",
    Env: [],
    WorkingDir: "/",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    HostConfig: { AutoRemove: true, Binds: [], CapAdd: [], SecurityOpt: [] },
  });
  const socket = await engine.attachContainer(id, true);
  const exit = await engine.watchExit(id);
  await engine.startContainer(id);
  const frames = demultiplexer();
  const output: string[] = [];
  socket.on("data", (chunk: Buffer) => {
    for (const { stream, data } of frames(chunk))
      output.push(`${stream}:${data.toString("utf8")}`);
  });
  const closed = new Promise((resolve) => socket.on("close", resolve));
  socket.write("hello\n");
  // Ending only the writing half: the container's output still comes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  socket.end();
  expect(await exit.status).toBe(3);
  await closed;
  expect(output).toEqual(["stderr:started\n", "stdout:hello\n"]);
  expect(fake.containers.get(id)).toMatchObject({
    stdin: "hello\n",
    removed: true,
  });
  expect(fake.calls("POST", `/containers/${id}/wait`)[0]!.query).toEqual({
    condition: "removed",
  });
  expect(fake.calls("POST", `/containers/${id}/attach`)[0]!.query).toEqual({
    stream: "1",
    stdin: "1",
    stdout: "1",
    stderr: "1",
  });

  // What is gone already is no error to kill or remove.
  await engine.killContainer(id, "SIGTERM");
  await engine.removeContainer("container9");
});

test("frames are read across the chunks they arrive in", () => {
  const frames = demultiplexer();
  const frame = (stream: number, text: string) => {
    const data = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  const stream = Buffer.concat([
    frame(1, "out"),
    frame(2, "err"),
    frame(1, ""),
  ]);
  const read = [
    ...frames(stream.subarray(0, 5)),
    ...frames(stream.subarray(5, 13)),
    ...frames(stream.subarray(13)),
  ].map(({ stream, data }) => [stream, data.toString("utf8")]);
  expect(read).toEqual([
    ["stdout", "out"],
    ["stderr", "err"],
    ["stdout", ""],
  ]);
});
