import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  cacheRoot as coreCacheRoot,
  dataRoot as coreDataRoot,
  stateRoot as coreStateRoot,
  TOOLBELT_VERSION_FILE as CORE_TOOLBELT_VERSION_FILE,
  toolbeltPath,
} from "@bayma/core";
import { MCP_CLIENTS, register } from "../../../packages/cli/src/clients.ts";
import type { Context } from "../../../packages/cli/src/context.ts";
import { pullReporter } from "../../../packages/cli/src/image.ts";
import {
  cacheRoot,
  dataRoot,
  installedCli,
  pathEnvironment,
  stateRoot,
  TOOLBELT_VERSION_FILE,
  toolbeltDir,
} from "../../../packages/cli/src/paths.ts";
import { VERSION } from "../../../packages/cli/src/release.ts";
import { setUp } from "../../../packages/cli/src/setup.ts";
import { readStatus, renderStatus } from "../../../packages/cli/src/status.ts";
import { uninstall } from "../../../packages/cli/src/uninstall.ts";
import { FakeDockerEngine } from "../../support/fake-docker-engine.ts";
import {
  FAKE_MCP_CLIENT_LOG,
  fakeMcpClientRuns,
  writeFakeMcpClients,
} from "../../support/fake-mcp-clients.ts";
import { withTempDir } from "../../support/temp.ts";

const IMAGE = "bayma:0.0.0";

const engines: FakeDockerEngine[] = [];
afterEach(async () => {
  for (const fake of engines.splice(0)) await fake.close();
});

/** A context in a home of its own, with the fake clients on PATH and Docker at `socket`. */
function testContext(
  home: string,
  socket: string,
  env: Record<string, string> = {},
): Context & { output(): string } {
  const bin = join(home, "bin");
  writeFakeMcpClients(bin);
  const bundle = join(home, "bundle.js");
  writeFileSync(bundle, "// the bayma command\n");
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => (output += chunk));
  return {
    uid: 1000,
    gid: 1000,
    home,
    cwd: home,
    env: {
      PATH: bin,
      DOCKER_HOST: `unix://${socket}`,
      BAYMA_IMAGE: IMAGE,
      [FAKE_MCP_CLIENT_LOG]: join(home, "clients.log"),
      ...env,
    },
    node: process.execPath,
    bundle,
    stdio: { stdin: new PassThrough(), stdout, stderr: new PassThrough() },
    output: () => output,
  };
}

async function engineWith(
  images: Record<
    string,
    { Id: string; RepoTags: string[] | null; RepoDigests: string[] | null }
  >,
): Promise<FakeDockerEngine> {
  const fake = await FakeDockerEngine.start({ images });
  engines.push(fake);
  return fake;
}

test("bayma's places here are those its container sees, by core's rules", () => {
  const home = "/home/ada";
  const environments: Record<string, string>[] = [
    { HOME: home },
    {
      HOME: home,
      XDG_DATA_HOME: "/home/ada/data",
      XDG_STATE_HOME: "/home/ada/.state",
      XDG_CACHE_HOME: "/home/ada/tmp/cache",
    },
  ];
  for (const env of environments) {
    const paths = pathEnvironment(home, env);
    expect(paths).toEqual(env);
    expect(dataRoot(paths)).toBe(coreDataRoot(env));
    expect(stateRoot(paths)).toBe(coreStateRoot(env));
    expect(cacheRoot(paths)).toBe(coreCacheRoot(env));
    expect(toolbeltDir(paths)).toBe(toolbeltPath(env));
  }
  expect(TOOLBELT_VERSION_FILE).toBe(CORE_TOOLBELT_VERSION_FILE);
});

test("an XDG base directory set to nothing is unset, and one outside HOME is refused", () => {
  expect(pathEnvironment("/home/ada", { XDG_DATA_HOME: "" })).toEqual({
    HOME: "/home/ada",
  });
  for (const value of ["/data", "/home/adam/data", "data", "/home/ada/../bob"])
    expect(() =>
      pathEnvironment("/home/ada", { XDG_STATE_HOME: value }),
    ).toThrow(
      `XDG_STATE_HOME is ${value}, outside HOME (/home/ada), the one directory bayma's container is given`,
    );
});

test("a pull's progress is a line rewritten on a terminal, and a line a layer elsewhere", () => {
  const events = [
    { status: "Pulling fs layer", id: "a" },
    { status: "Pulling fs layer", id: "b" },
    {
      status: "Downloading",
      id: "a",
      progressDetail: { current: 1_000_000, total: 4_000_000 },
    },
    {
      status: "Downloading",
      id: "b",
      progressDetail: { current: 0, total: 2_000_000 },
    },
    { status: "Download complete", id: "a" },
    { status: "Pull complete", id: "a" },
  ];
  const written = (isTTY: boolean) => {
    let text = "";
    const reporter = pullReporter({ isTTY, write: (chunk) => (text += chunk) });
    for (const event of events) reporter.event(event);
    reporter.end();
    return text;
  };
  expect(written(false)).toBe("pulled 1 of 2 layers, 4 of 6 MB downloaded\n");
  expect(written(true).split("\r\x1b[K").at(-1)).toBe(
    "pulled 1 of 2 layers, 4 of 6 MB downloaded\n",
  );
});

test("registering replaces what each client has as bayma, at the user's scope", async () => {
  await withTempDir(async (home) => {
    const context = testContext(home, "/nonexistent");
    const launch = {
      command: "/usr/bin/node",
      args: ["/cli/bayma.js", "mcp-stdio"],
    };
    for (const client of MCP_CLIENTS) {
      const result = await register(
        client,
        join(home, "bin", client.executable),
        launch,
        context.env,
      );
      expect(result.status).toBe(0);
    }
    expect(fakeMcpClientRuns(join(home, "clients.log"))).toEqual([
      "claude mcp remove --scope user bayma",
      "claude mcp add --scope user bayma -- /usr/bin/node /cli/bayma.js mcp-stdio",
      "codex mcp remove bayma",
      "codex mcp add bayma -- /usr/bin/node /cli/bayma.js mcp-stdio",
    ]);
  });
});

test("init installs the toolbelt, runs the doctor, installs this command, and registers it", async () => {
  const fake = await engineWith({
    [IMAGE]: { Id: "sha256:image", RepoTags: [IMAGE], RepoDigests: null },
  });
  await withTempDir(async (home) => {
    const context = testContext(home, fake.socketPath);
    expect(await setUp(context, false)).toBe(0);

    const commands = [...fake.containers.values()].map(({ spec }) => spec.Cmd);
    expect(commands).toEqual([["install-toolbelt"], ["doctor"]]);
    expect(fake.calls("POST", "/images/create")).toEqual([]);
    const cli = installedCli({ HOME: home }, VERSION);
    expect(readFileSync(cli, "utf8")).toBe("// the bayma command\n");
    expect(fakeMcpClientRuns(join(home, "clients.log"))).toEqual([
      "claude mcp remove --scope user bayma",
      `claude mcp add --scope user bayma -- ${process.execPath} ${cli} mcp-stdio`,
      "codex mcp remove bayma",
      `codex mcp add bayma -- ${process.execPath} ${cli} mcp-stdio`,
    ]);
    expect(context.output()).toContain(
      JSON.stringify(
        {
          mcpServers: {
            bayma: { command: process.execPath, args: [cli, "mcp-stdio"] },
          },
        },
        null,
        2,
      ),
    );
  });
});

test("init registers bayma when its doctor fails, and warns of it last", async () => {
  const fake = await FakeDockerEngine.start({
    images: {
      [IMAGE]: { Id: "sha256:image", RepoTags: [IMAGE], RepoDigests: null },
    },
    exitStatus: (command) => (command === "doctor" ? 1 : 0),
  });
  engines.push(fake);
  await withTempDir(async (home) => {
    const data = join(home, "data");
    const context = testContext(home, fake.socketPath, { XDG_DATA_HOME: data });
    expect(await setUp(context, false)).toBe(0);

    // The containers find the toolbelt where this command looks for it.
    for (const { spec } of fake.containers.values())
      expect(spec.Env).toContain(`XDG_DATA_HOME=${data}`);
    const cli = installedCli({ HOME: home, XDG_DATA_HOME: data }, VERSION);
    expect(cli.startsWith(join(data, "bayma", "cli"))).toBe(true);
    expect(fakeMcpClientRuns(join(home, "clients.log"))).toHaveLength(4);
    expect(context.output().trimEnd().split("\n").at(-1)).toStartWith(
      "warning: bayma doctor failed with status 1, so a runtime its report above names as failing does not work here; bayma is registered all the same",
    );
  });
});

test("init stops before it registers anything when the toolbelt cannot be installed", async () => {
  const fake = await FakeDockerEngine.start({
    images: {
      [IMAGE]: { Id: "sha256:image", RepoTags: [IMAGE], RepoDigests: null },
    },
    exitStatus: (command) => (command === "install-toolbelt" ? 1 : 0),
  });
  engines.push(fake);
  await withTempDir(async (home) => {
    const context = testContext(home, fake.socketPath);
    await expect(setUp(context, false)).rejects.toThrow(
      "bayma install-toolbelt failed with status 1, as it says above; bayma is not registered",
    );
    expect(existsSync(installedCli({ HOME: home }, VERSION))).toBe(false);
    expect(fakeMcpClientRuns(join(home, "clients.log"))).toEqual([]);
  });
});

test("init without an image BAYMA_IMAGE names refuses before it changes anything", async () => {
  const fake = await engineWith({});
  await withTempDir(async (home) => {
    const context = testContext(home, fake.socketPath);
    await expect(setUp(context, false)).rejects.toThrow(
      "BAYMA_IMAGE names bayma:0.0.0, which Docker does not have",
    );
    expect(fake.calls("POST", "/images/create")).toEqual([]);
    expect(existsSync(installedCli({ HOME: home }, VERSION))).toBe(false);
    expect(fakeMcpClientRuns(join(home, "clients.log"))).toEqual([]);
  });
});

test("status reads each client's registration, and says which would not start bayma", async () => {
  const fake = await engineWith({
    [IMAGE]: { Id: "sha256:image", RepoTags: [IMAGE], RepoDigests: null },
  });
  await withTempDir(async (home) => {
    const context = testContext(home, fake.socketPath, {
      CODEX_HOME: join(home, "codex"),
    });
    const cli = installedCli({ HOME: home }, VERSION);
    mkdirSync(join(cli, ".."), { recursive: true });
    writeFileSync(cli, "");
    mkdirSync(toolbeltDir({ HOME: home }), { recursive: true });
    writeFileSync(
      join(toolbeltDir({ HOME: home }), TOOLBELT_VERSION_FILE),
      "0.0.0\n",
    );
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          bayma: {
            type: "stdio",
            command: process.execPath,
            args: [cli, "mcp-stdio"],
            env: {},
          },
        },
      }),
    );
    mkdirSync(join(home, "codex"));
    writeFileSync(
      join(home, "codex", "config.toml"),
      `model = "gpt-5"\n\n[mcp_servers.bayma]\ncommand = "/gone/node"\nargs = ["${cli}", "mcp-stdio"]\n\n[mcp_servers.other]\ncommand = "other"\n`,
    );

    const status = await readStatus(context);
    expect(status).toMatchObject({
      version: VERSION,
      docker: { socket: fake.socketPath, version: "29.0.0" },
      image: { image: { reference: IMAGE, pinned: false }, present: true },
      toolbelt: { path: toolbeltDir({ HOME: home }), version: "0.0.0" },
      installed: [VERSION],
    });
    expect(status.registrations).toEqual([
      {
        client: "Claude Code",
        launch: { command: process.execPath, args: [cli, "mcp-stdio"] },
        problem: undefined,
      },
      {
        client: "Codex",
        launch: { command: "/gone/node", args: [cli, "mcp-stdio"] },
        problem: "/gone/node is not there to run",
      },
    ]);
    expect(renderStatus(status)).toContain(
      `Codex: /gone/node ${cli} mcp-stdio, which is broken: /gone/node is not there to run; npx bayma init registers bayma again`,
    );
  });
});

test("status without Docker says why, and still reads what is installed", async () => {
  await withTempDir(async (home) => {
    const status = await readStatus(testContext(home, join(home, "no.sock")));
    expect(status.docker.problem).toContain("No Docker Engine runs here");
    expect(status.image.present).toBeUndefined();
    expect(status.registrations.map(({ launch }) => launch)).toEqual([
      undefined,
      undefined,
    ]);
  });
});

test("uninstall removes registrations, commands, pulled images, the toolbelt, and the cache; --purge, REPL sessions' state", async () => {
  const pulled = "ghcr.io/eaucoin/bayma@sha256:aaaa";
  const fake = await engineWith({
    [pulled]: { Id: "sha256:a", RepoTags: null, RepoDigests: [pulled] },
    [IMAGE]: { Id: "sha256:image", RepoTags: [IMAGE], RepoDigests: null },
  });
  await withTempDir(async (home) => {
    const context = testContext(home, fake.socketPath);
    for (const directory of [
      join(installedCli({ HOME: home }, VERSION), ".."),
      toolbeltDir({ HOME: home }),
      cacheRoot({ HOME: home }),
      join(stateRoot({ HOME: home }), "0123456789abcdef"),
    ])
      mkdirSync(directory, { recursive: true });

    expect(await uninstall(context, false)).toBe(0);
    expect(fakeMcpClientRuns(join(home, "clients.log"))).toEqual([
      "claude mcp remove --scope user bayma",
      "codex mcp remove bayma",
    ]);
    // What BAYMA_IMAGE names was never pulled, so it stays.
    expect(fake.removedImages).toEqual([pulled]);
    expect(existsSync(dataRoot({ HOME: home }))).toBe(false);
    expect(existsSync(cacheRoot({ HOME: home }))).toBe(false);
    expect(existsSync(stateRoot({ HOME: home }))).toBe(true);
    expect(context.output()).toContain("uninstall --purge removes it");

    expect(await uninstall(context, true)).toBe(0);
    expect(existsSync(stateRoot({ HOME: home }))).toBe(false);
    expect(context.output()).toContain(
      "removing REPL sessions' state, of the 1 directory MCP clients launched bayma from",
    );
  });
});
