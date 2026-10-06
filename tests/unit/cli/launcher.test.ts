import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { DockerEngine } from "../../../packages/cli/src/docker.ts";
import {
  containerSpec,
  type Invocation,
  runContainer,
} from "../../../packages/cli/src/launcher.ts";
import { FakeDockerEngine } from "../../support/fake-docker-engine.ts";

const INVOCATION: Invocation = {
  uid: 1000,
  gid: 1001,
  home: "/home/ada",
  cwd: "/home/ada/project",
  env: {
    PATH: "/usr/bin",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_SERVICE_NAME: "bayma-ada",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  },
};

const IMAGE = { reference: "bayma:0.0.0", pinned: false };

test("mcp-stdio runs as docker run -i --rm did, as the user, in their home, able to snapshot, with OpenTelemetry's variables passed in", () => {
  expect(
    containerSpec(
      "ghcr.io/eaucoin/bayma@sha256:1234",
      "mcp-stdio",
      ["--max-sessions", "4"],
      INVOCATION,
    ),
  ).toEqual({
    Image: "ghcr.io/eaucoin/bayma@sha256:1234",
    Cmd: ["mcp-stdio", "--max-sessions", "4"],
    User: "1000:1001",
    Env: [
      "HOME=/home/ada",
      "OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318",
      "OTEL_SERVICE_NAME=bayma-ada",
    ],
    WorkingDir: "/home/ada/project",
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    HostConfig: {
      AutoRemove: true,
      Binds: ["/home/ada:/home/ada"],
      CapAdd: ["CHECKPOINT_RESTORE", "SYS_PTRACE"],
      SecurityOpt: ["seccomp=unconfined"],
    },
  });
});

test("mcp-http shares the machine's network and reads no stdin; the doctor neither", () => {
  const http = containerSpec(
    "bayma:0.0.0",
    "mcp-http",
    ["--port", "7300"],
    INVOCATION,
  );
  expect(http.Cmd).toEqual(["mcp-http", "--port", "7300"]);
  expect(http.HostConfig.NetworkMode).toBe("host");
  expect([http.AttachStdin, http.OpenStdin, http.StdinOnce]).toEqual([
    false,
    false,
    false,
  ]);

  const doctor = containerSpec("bayma:0.0.0", "doctor", [], INVOCATION);
  expect(doctor.HostConfig.NetworkMode).toBeUndefined();
  expect(doctor.OpenStdin).toBe(false);
  expect(doctor.HostConfig.Binds).toEqual(["/home/ada:/home/ada"]);
});

const engines: FakeDockerEngine[] = [];
afterEach(async () => {
  for (const fake of engines.splice(0)) await fake.close();
});

function stdio() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const read = (stream: PassThrough) => {
    let text = "";
    stream.on("data", (chunk) => (text += chunk));
    return () => text;
  };
  return {
    streams: { stdin, stdout, stderr },
    stdout: read(stdout),
    stderr: read(stderr),
  };
}

test("the launcher forwards stdio, ends the container's stdin with its own, and exits with the container's status", async () => {
  const fake = await FakeDockerEngine.start({
    images: {
      "bayma:0.0.0": {
        Id: "sha256:image",
        RepoTags: ["bayma:0.0.0"],
        RepoDigests: null,
      },
    },
    exitStatus: 7,
  });
  engines.push(fake);
  const io = stdio();
  const running = runContainer(
    new DockerEngine(fake.socketPath),
    IMAGE,
    containerSpec("bayma:0.0.0", "mcp-stdio", [], INVOCATION),
    io.streams,
  );
  io.streams.stdin.write('{"jsonrpc":"2.0"}\n');
  io.streams.stdin.end();
  expect(await running).toBe(7);
  expect(io.stdout()).toBe('{"jsonrpc":"2.0"}\n');
  expect(io.stderr()).toBe("started\n");
  const [container] = fake.containers.values();
  expect(container).toMatchObject({
    removed: true,
    stdin: '{"jsonrpc":"2.0"}\n',
  });
  // Attached and watched before it started, so nothing it did was missed.
  expect(
    fake.requests
      .filter(({ method }) => method === "POST")
      .map(({ path }) => path.split("/").pop()),
  ).toEqual(["create", "attach", "wait", "start"]);
});

test("the launcher forwards SIGTERM to the container, and exits with the status it died of", async () => {
  const fake = await FakeDockerEngine.start({
    images: {
      "bayma:0.0.0": {
        Id: "sha256:image",
        RepoTags: ["bayma:0.0.0"],
        RepoDigests: null,
      },
    },
  });
  engines.push(fake);
  const listeners = process.listenerCount("SIGTERM");
  const io = stdio();
  const running = runContainer(
    new DockerEngine(fake.socketPath),
    IMAGE,
    containerSpec("bayma:0.0.0", "mcp-stdio", [], INVOCATION),
    io.streams,
  );
  while (![...fake.containers.values()].some(({ started }) => started))
    await new Promise((resolve) => setTimeout(resolve, 5));
  process.emit("SIGTERM", "SIGTERM");
  expect(await running).toBe(143);
  expect([...fake.containers.values()][0]!.signals).toEqual(["SIGTERM"]);
  expect(process.listenerCount("SIGTERM")).toBe(listeners);
});

test("a launcher whose image is missing says to run init, and never pulls", async () => {
  const fake = await FakeDockerEngine.start();
  engines.push(fake);
  await expect(
    runContainer(
      new DockerEngine(fake.socketPath),
      { reference: "ghcr.io/eaucoin/bayma@sha256:1234", pinned: true },
      containerSpec(
        "ghcr.io/eaucoin/bayma@sha256:1234",
        "mcp-stdio",
        [],
        INVOCATION,
      ),
      stdio().streams,
    ),
  ).rejects.toThrow(
    "bayma's image ghcr.io/eaucoin/bayma@sha256:1234 is not here: run npx bayma@",
  );
  expect(fake.calls("POST", "/images/create")).toEqual([]);
});
