import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { RUNTIME_IDS, type ExecActivity, type RuntimeId } from "@bayma/core";

// bayma as a host that saves whole sandboxes runs it: the image `bun run
// image` builds, in a gVisor sandbox under Docker, saved by runsc beside
// Docker's shim, as a node agent saves a pod's, then restored into a new
// container, on another address, after its clients' idle timeout has
// passed. Its sessions in every runtime come back with their live state,
// the exec it was running goes on, an MCP SDK client that held its MCP
// session carries on in it at the new address, and the server answers the
// token its new container gave it alone. Saved live, left running and then
// killed, it comes back from that save too, and, saved as it installed its
// toolbelt, installs it again; told a client of a change after the save, it
// refuses to be restored from it. Its runtime memory budget holds a Go host
// in the sandbox, whose /proc says its memory in smaps alone.
//
// It needs root through sudo, Docker with gVisor's runsc registered as the
// runtime `runsc`, and Docker's experimental features, which restore a
// container from a checkpoint: ci.yml's sandbox job sets them up.

const repoRoot = resolve(import.meta.dir, "..", "..");
const version = JSON.parse(
  readFileSync(join(repoRoot, "packages", "server", "package.json"), "utf8"),
).version as string;
const IMAGE = `bayma:${version}`;
const TEST_TIMEOUT_MS = 1_800_000;
// No command the tests run takes this long: one that does is stuck, and its
// failure says which, before the test's own timeout ends it saying nothing.
const COMMAND_TIMEOUT_MS = 600_000;
// Where runsc keeps the state of the sandboxes Docker's containerd starts,
// in its moby namespace, through gVisor's shim.
const RUNSC_ROOT = "/run/containerd/runsc/moby";
// How many cells the Go session of the test of saves' sizes runs.
const GO_CELLS = 100;
// The clients' idle timeout, which the sandbox stays saved for longer than.
const IDLE_TIMEOUT_MS = 30_000;
const SAVED_FOR_MS = 45_000;
const PORT = 7290;

/** Code that leaves 41 in a live variable, and code that reads it plus one. */
const LIVE_STATE: Record<RuntimeId, { define: string; read: string }> = {
  bun: { define: "const marker = 41", read: "marker + 1" },
  python: { define: "marker = 41", read: "marker + 1" },
  "dotnet-script": { define: "var marker = 41;", read: "marker + 1" },
  rust: { define: "let marker = 41;", read: "marker + 1" },
  c: { define: "int marker = 41;", read: "marker + 1" },
  cpp: { define: "int marker = 41;", read: "marker + 1" },
  lean: { define: "def marker := 41", read: "#eval marker + 1" },
  go: { define: "var marker = 41", read: "marker + 1" },
};

interface ExecSnapshot {
  exec_id: string;
  status: string;
  done: boolean;
  next_seq: number;
  result_text: string;
  error_text: string;
  notice?: string;
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0)
    throw new Error(`${command.join(" ")} exited ${status}: ${stderr}`);
  return stdout.trim();
}

/** What a container said, for whoever reads a failure. */
async function logs(name: string): Promise<string> {
  const child = Bun.spawn(["docker", "logs", name], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return `${name}:\n${stdout}${stderr}`;
}

/** Resolves once what a container said holds `text`, within two minutes. */
async function logged(name: string, text: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!(await logs(name)).includes(text)) {
    if (Date.now() > deadline)
      throw new Error(`${name} did not say "${text}" within 120 s`);
    await sleep(250);
  }
}

/**
 * The argv runsc runs bayma's hook with in the sandbox, from what the image
 * runs: gVisor splits it at spaces and runs its first word as a path.
 */
async function hookArgv(stateDir: string): Promise<string> {
  const entrypoint = JSON.parse(
    await run([
      "docker",
      "image",
      "inspect",
      "--format",
      "{{json .Config.Entrypoint}}",
      IMAGE,
    ]),
  ) as string[];
  // What tini runs, after its `--`, the last of prlimit's and its own.
  const [command, ...args] = entrypoint.slice(entrypoint.lastIndexOf("--") + 1);
  const path = await run([
    "docker",
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    `command -v ${command}`,
  ]);
  return [path, ...args, "sandbox-hook", "--state-dir", stateDir].join(" ");
}

/** A container serving mcp-http in a gVisor sandbox, created or run, with `serverArgs` besides. */
function container(
  how: "create" | "run",
  name: string,
  home: string,
  stateDir: string,
  tokenFile: string,
  serverArgs: readonly string[] = [],
): string[] {
  return [
    "docker",
    how,
    ...(how === "run" ? ["--detach"] : []),
    "--runtime",
    "runsc",
    "--name",
    name,
    "--hostname",
    "bayma",
    "--publish",
    `127.0.0.1::${PORT}`,
    "--user",
    `${process.getuid!()}:${process.getgid!()}`,
    "--env",
    `HOME=${home}`,
    "--volume",
    `${home}:${home}`,
    "--workdir",
    home,
    IMAGE,
    "mcp-http",
    "--host",
    "0.0.0.0",
    "--port",
    String(PORT),
    "--state-dir",
    stateDir,
    "--default-durability",
    "checkpointed",
    "--client-idle-timeout-ms",
    String(IDLE_TIMEOUT_MS),
    "--token-file",
    tokenFile,
    ...serverArgs,
  ];
}

/** The URL a container's mcp-http answers on, once it answers. */
async function serving(name: string): Promise<string> {
  const address = await run(["docker", "port", name, String(PORT)]);
  const url = `http://${address.split("\n")[0]}/mcp`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "POST" });
      return url;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`${name} does not answer on ${url}`);
}

/** An MCP session a client held, to go on in. */
interface HeldSession {
  sessionId?: string;
  protocolVersion?: string;
}

async function connect(
  url: string,
  token: string,
  held: HeldSession = {},
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    sessionId: held.sessionId,
    protocolVersion: held.protocolVersion,
  });
  const client = new Client({ name: "bayma-sandbox-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }, { timeout: 600_000 }),
  );
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as T;
}

async function settled(
  client: Client,
  sessionId: string,
  snapshot: ExecSnapshot,
): Promise<ExecSnapshot> {
  let current = snapshot;
  while (!current.done) {
    current = await call<ExecSnapshot>(client, "wait", {
      session_id: sessionId,
      exec_id: current.exec_id,
      from_seq: current.next_seq,
      yield_time_ms: 60_000,
    });
  }
  return current;
}

async function exec(
  client: Client,
  sessionId: string,
  code: string,
): Promise<ExecSnapshot> {
  return settled(
    client,
    sessionId,
    await call<ExecSnapshot>(client, "exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 60_000,
    }),
  );
}

async function activity(url: string, token: string): Promise<Response> {
  return fetch(new URL("/status", url), {
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * An MCP session that holds no stream open, as a client between requests:
 * the one its idle timeout closes.
 */
async function idleMcpSession(url: string, token: string): Promise<string> {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  const initialized = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "idle", version: "1.0.0" },
      },
    }),
  });
  await initialized.body?.cancel();
  const mcpSessionId = initialized.headers.get("mcp-session-id")!;
  const notified = await fetch(url, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": mcpSessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  await notified.body?.cancel();
  return mcpSessionId;
}

async function ping(
  url: string,
  token: string,
  mcpSessionId: string,
): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-session-id": mcpSessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
  });
  await response.body?.cancel();
  return response.status;
}

test(
  "bayma saved whole by runsc comes back in a new container, every session with its live state",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "bayma-sandbox-"));
    const stateDir = join(home, ".local", "state", "bayma", "test");
    mkdirSync(stateDir, { recursive: true });
    const tokenFile = join(home, "token");
    writeFileSync(tokenFile, "first-token\n");
    const images = mkdtempSync(join(tmpdir(), "bayma-checkpoints-"));
    const suffix = `${process.pid}-${Date.now()}`;
    const [saved, restored] = [
      `bayma-saved-${suffix}`,
      `bayma-restored-${suffix}`,
    ];
    try {
      await run(container("run", saved, home, stateDir, tokenFile));
      const savedUrl = await serving(saved);
      const first = await connect(savedUrl, "first-token");
      const sessions = new Map<RuntimeId, string>();
      for (const runtimeId of RUNTIME_IDS) {
        const created = await call<{ session: { session_id: string } }>(
          first.client,
          "session.create",
          { runtime: runtimeId, title: `sandbox-${runtimeId}`, cwd: home },
        );
        sessions.set(runtimeId, created.session.session_id);
        const defined = await exec(
          first.client,
          created.session.session_id,
          LIVE_STATE[runtimeId].define,
        );
        expect({ runtimeId, status: defined.status }).toEqual({
          runtimeId,
          status: "ok",
        });
      }
      const busy = await call<{ session: { session_id: string } }>(
        first.client,
        "session.create",
        { runtime: "bun", title: "sandbox-busy", cwd: home },
      );
      // Running until the test lets it end, once restored.
      const restoredFlag = join(home, "restored");
      const running = await call<ExecSnapshot>(first.client, "exec", {
        session_id: busy.session.session_id,
        code: `while (!require("node:fs").existsSync(${JSON.stringify(restoredFlag)})) await Bun.sleep(100); 42`,
        yield_time_ms: 0,
      });
      const noted = await exec(
        first.client,
        sessions.get("bun")!,
        "globalThis.monotonicAtSave = performance.now()",
      );
      expect(noted.status).toBe("ok");
      const idle = await idleMcpSession(savedUrl, "first-token");
      expect(
        (await (
          await activity(savedUrl, "first-token")
        ).json()) as ExecActivity,
      ).toEqual({
        execsRunning: 1,
        execsQueued: 0,
        running: [
          { sessionId: busy.session.session_id, execId: running.exec_id },
        ],
        idleSinceMs: null,
        generation: expect.any(Number),
      });

      // Saved beside Docker's shim, running bayma's hook first, as a node
      // agent saves a pod's sandbox.
      const id = await run(["docker", "inspect", "--format", "{{.Id}}", saved]);
      const image = join(images, "checkpoint");
      const savingAtMs = Date.now();
      await run([
        "sudo",
        "runsc",
        "--root",
        RUNSC_ROOT,
        "checkpoint",
        "--image-path",
        image,
        `--save-restore-exec-argv=${await hookArgv(stateDir)}`,
        id,
      ]);
      console.log(`saved in ${Date.now() - savingAtMs} ms`);
      await run(["docker", "wait", saved]);
      // Its connection to the saved container is gone; it keeps its MCP
      // session to go on in.
      const held: HeldSession = {
        sessionId: first.transport.sessionId,
        protocolVersion: first.transport.protocolVersion,
      };
      await first.client.close();
      await sleep(SAVED_FOR_MS);

      // Restored into a new container, on a new address, with a new token.
      writeFileSync(tokenFile, "second-token\n");
      const restoredId = await run(
        container("create", restored, home, stateDir, tokenFile),
      );
      // Docker restores a container from a checkpoint among its own.
      const checkpoints = `/var/lib/docker/containers/${restoredId}/checkpoints`;
      await run(["sudo", "mkdir", "-p", checkpoints]);
      await run(["sudo", "cp", "-a", image, join(checkpoints, "checkpoint")]);
      const restoringAtMs = Date.now();
      await run(["docker", "start", "--checkpoint", "checkpoint", restored]);
      const restoredUrl = await serving(restored);
      console.log(`restored in ${Date.now() - restoringAtMs} ms`);
      expect(restoredId).not.toBe(id);

      expect((await activity(restoredUrl, "first-token")).status).toBe(401);
      // The idle MCP session outlived its idle timeout while saved.
      expect(await ping(restoredUrl, "second-token", idle)).toBe(200);

      const second = await connect(restoredUrl, "second-token", held);
      writeFileSync(restoredFlag, "");
      const finished = await settled(
        second.client,
        busy.session.session_id,
        await call<ExecSnapshot>(second.client, "wait", {
          session_id: busy.session.session_id,
          exec_id: running.exec_id,
          yield_time_ms: 60_000,
        }),
      );
      expect(finished.result_text.trim()).toBe("42");
      expect(finished.notice).toStartWith(
        "bayma: this session came back whole with bayma's sandbox",
      );
      for (const runtimeId of RUNTIME_IDS) {
        const read = await exec(
          second.client,
          sessions.get(runtimeId)!,
          LIVE_STATE[runtimeId].read,
        );
        expect({
          runtimeId,
          status: read.status,
          result: read.result_text.trim(),
          error: read.error_text,
          told: read.notice?.startsWith(
            "bayma: this session came back whole with bayma's sandbox",
          ),
        }).toEqual({
          runtimeId,
          status: "ok",
          result: "42",
          error: "",
          told: true,
        });
      }
      // The Go host came back mapping the plugins of its module, which are
      // on the disk still: the server alone removes them.
      const plugins = join(
        stateDir,
        "scratch",
        sessions.get("go")!,
        "go",
        "*",
        "plugins",
        "*.so",
      );
      const kept = await exec(
        second.client,
        sessions.get("python")!,
        `import glob\nlen(glob.glob(${JSON.stringify(plugins)}))`,
      );
      expect(kept.status).toBe("ok");
      expect(Number(kept.result_text.trim())).toBeGreaterThan(0);
      // The clocks moved on by the time it stayed saved, which a timeout
      // armed before the save would have measured.
      const monotonic = await exec(
        second.client,
        sessions.get("bun")!,
        "performance.now() - monotonicAtSave",
      );
      expect(Number(monotonic.result_text)).toBeGreaterThanOrEqual(
        SAVED_FOR_MS,
      );
      expect(
        (await (
          await activity(restoredUrl, "second-token")
        ).json()) as ExecActivity,
      ).toEqual({
        execsRunning: 0,
        execsQueued: 0,
        running: [],
        idleSinceMs: expect.any(Number),
        generation: expect.any(Number),
      });
      await second.client.close();
    } finally {
      // What is left goes, without hiding why the test failed, if it did.
      for (const name of [saved, restored]) {
        console.log(await logs(name));
        await run(["docker", "rm", "--force", name]).catch(() => undefined);
      }
      await run(["sudo", "rm", "-rf", images, home]).catch((error) =>
        console.error(error),
      );
    }
  },
  TEST_TIMEOUT_MS,
);

/** How a sandbox saved live is restored, as savedLiveThenKilled runs it. */
interface LiveSave {
  /** The runtime of the session the save catches. */
  runtime: "bun" | "go";
  /** Whether the save catches the toolbelt's install, or follows it. */
  whileInstalling: boolean;
  /**
   * What the sandbox, left running, does after the save and before it
   * is killed: nothing, or an interrupt of an exec, which recycles a Go host.
   * Either way it serves /status, which moves nothing.
   */
  after: "nothing" | "interrupt";
}

/**
 * Saves bayma live, as a host that saves a sandbox live does, then kills it
 * and restores the save into a new container. Where nothing a client was told
 * of happened after the save, the restored bayma carries on with its
 * sessions, and, saved while it installed the toolbelt, installs it again.
 * Where something did, the state generation has moved on, the restore is
 * refused, and the container falls back to starting afresh, its sessions
 * coming back from their checkpoints.
 */
async function savedLiveThenKilled({
  runtime,
  whileInstalling,
  after,
}: LiveSave): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "bayma-sandbox-"));
  const stateDir = join(home, ".local", "state", "bayma", "test");
  mkdirSync(stateDir, { recursive: true });
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, "token\n");
  const images = mkdtempSync(join(tmpdir(), "bayma-checkpoints-"));
  const suffix = `${process.pid}-${Date.now()}`;
  const [saved, restored] = [
    `bayma-saved-${suffix}`,
    `bayma-restored-${suffix}`,
  ];
  try {
    await run(container("run", saved, home, stateDir, tokenFile));
    // The install copies the toolbelt into the home, beside the sessions.
    await logged(
      saved,
      whileInstalling ? "bayma: installing the " : "bayma: installed the ",
    );
    const url = await serving(saved);
    const first = await connect(url, "token");
    const { session } = await call<{ session: { session_id: string } }>(
      first.client,
      "session.create",
      { runtime, title: "sandbox-live", cwd: home },
    );
    const defined = await exec(
      first.client,
      session.session_id,
      LIVE_STATE[runtime].define,
    );
    expect(defined.status).toBe("ok");

    // Saved while it runs, and left running, as a host that saves a
    // sandbox live does; then killed, as a host that loses the sandbox
    // loses it: whatever it held goes with it. A server stopped as it
    // shuts down persists its sessions as it goes, which moves the state
    // generation on, so that the save is refused.
    const id = await run(["docker", "inspect", "--format", "{{.Id}}", saved]);
    const image = join(images, "checkpoint");
    const savingAtMs = Date.now();
    await run([
      "sudo",
      "runsc",
      "--root",
      RUNSC_ROOT,
      "checkpoint",
      "--image-path",
      image,
      "--leave-running",
      `--save-restore-exec-argv=${await hookArgv(stateDir)}`,
      id,
    ]);
    console.log(`saved live in ${Date.now() - savingAtMs} ms`);
    // It runs on, and serves its clients.
    const running = await activity(url, "token");
    expect(running.status).toBe(200);
    const { generation } = (await running.json()) as ExecActivity;
    if (after === "interrupt") {
      // The Go host's module, which the save caught it mapping its plugins in.
      const goScratch = join(stateDir, "scratch", session.session_id, "go");
      const modules = async () =>
        (await run(["sudo", "ls", goScratch])).split("\n").filter(Boolean);
      const caught = await modules();
      expect(caught).toHaveLength(1);
      await call(first.client, "exec", {
        session_id: session.session_id,
        code: LOOPS[runtime],
        yield_time_ms: 1_000,
      });
      await call(first.client, "session.interrupt", {
        session_id: session.session_id,
      });
      const moved = (await (
        await activity(url, "token")
      ).json()) as ExecActivity;
      expect(moved.generation).toBeGreaterThan(generation);
      // The server removes the recycled host's module once the generation
      // has moved on.
      const removedBy = Date.now() + 10_000;
      while ((await modules()).includes(caught[0]!)) {
        if (Date.now() > removedBy)
          throw new Error(
            `the recycled Go host's module ${caught[0]} is still there`,
          );
        await sleep(100);
      }
    }
    // It keeps its MCP session, which controls the bayma session, to go
    // on in.
    const held: HeldSession = {
      sessionId: first.transport.sessionId,
      protocolVersion: first.transport.protocolVersion,
    };
    await first.client.close();
    await run(["docker", "kill", saved]);

    const restoredId = await run(
      container("create", restored, home, stateDir, tokenFile),
    );
    const checkpoints = `/var/lib/docker/containers/${restoredId}/checkpoints`;
    await run(["sudo", "mkdir", "-p", checkpoints]);
    await run(["sudo", "cp", "-a", image, join(checkpoints, "checkpoint")]);
    const restoringAtMs = Date.now();
    const restore = run([
      "docker",
      "start",
      "--checkpoint",
      "checkpoint",
      restored,
    ]);
    if (after === "interrupt") {
      // The save caught the Go host mapping its cells' plugins, in its
      // module; the interrupt recycled it, and the server removed its module
      // once the generation had moved on. runsc refuses the restore as it
      // finds the module gone, before bayma's restore hook would refuse it
      // for the generation.
      await expect(restore).rejects.toThrow(
        new RegExp(
          `failed to walk "[^"]*/scratch/${session.session_id}/go/[0-9]+-[0-9a-f]+"`,
          "u",
        ),
      );
      console.log(`refused in ${Date.now() - restoringAtMs} ms`);
      await run(["docker", "start", restored]);
      const second = await connect(await serving(restored), "token");
      // Started afresh, the server holds no MCP session of before: the
      // session's controller is a client that has none open now.
      await call(second.client, "session.acquire_controller", {
        session_id: session.session_id,
      });
      const read = await exec(
        second.client,
        session.session_id,
        LIVE_STATE[runtime].read,
      );
      // Back from its checkpoint, which keeps no variable.
      expect(read.status).not.toBe("ok");
      await second.client.close();
      return;
    }
    await restore;
    const restoredUrl = await serving(restored);
    console.log(`restored in ${Date.now() - restoringAtMs} ms`);
    const second = await connect(restoredUrl, "token", held);
    const read = await exec(
      second.client,
      session.session_id,
      LIVE_STATE[runtime].read,
    );
    expect({ status: read.status, result: read.result_text.trim() }).toEqual({
      status: "ok",
      result: "42",
    });
    await second.client.close();
    if (whileInstalling) {
      await logged(
        restored,
        "bayma: installing the toolbelt again, as the sandbox was restored from a save taken while it installed",
      );
      await logged(restored, "bayma: installed the ");
    }
  } finally {
    for (const name of [saved, restored]) {
      console.log(await logs(name));
      await run(["docker", "rm", "--force", name]).catch(() => undefined);
    }
    await run(["sudo", "rm", "-rf", images, home]).catch((error) =>
      console.error(error),
    );
  }
}

/** A cell that runs until it is interrupted. */
const LOOPS: Record<LiveSave["runtime"], string> = {
  bun: "for (;;) {}",
  go: "for {\n}",
};

test(
  "bayma saved live, then killed, comes back from the save in a new container",
  () =>
    savedLiveThenKilled({
      runtime: "bun",
      whileInstalling: false,
      after: "nothing",
    }),
  TEST_TIMEOUT_MS,
);

// The save holds the install, its files closed, so that what it assembled
// may move on once the sandbox runs on: the restore installs it again.
test(
  "bayma saved live while it installs the toolbelt, then killed, comes back and installs it again",
  () =>
    savedLiveThenKilled({
      runtime: "bun",
      whileInstalling: true,
      after: "nothing",
    }),
  TEST_TIMEOUT_MS,
);

// A Go host maps its session's plugins, which stay on the disk while a save
// the generation matches may map them.
test(
  "bayma saved live with a Go session, then killed, comes back from the save",
  () =>
    savedLiveThenKilled({
      runtime: "go",
      whileInstalling: false,
      after: "nothing",
    }),
  TEST_TIMEOUT_MS,
);

// A gVisor whose failed restores end, as ci.yml says by
// GVISOR_ENDS_FAILED_RESTORES, lets docker start report the refusal.
test.skipIf(process.env.GVISOR_ENDS_FAILED_RESTORES !== "1")(
  "bayma saved live with a Go session, then interrupted, refuses the save, which falls back to the session's checkpoint",
  () =>
    savedLiveThenKilled({
      runtime: "go",
      whileInstalling: false,
      after: "interrupt",
    }),
  TEST_TIMEOUT_MS,
);

test(
  "a Go session's cells add nothing to the state of a whole save of bayma's sandbox",
  async () => {
    // The bytes of the state file of a save of a sandbox whose Go session
    // ran `cells` cells, and the Sentry's own memory as it saved it.
    const saveAfter = async (cells: number) => {
      const home = mkdtempSync(join(tmpdir(), "bayma-sandbox-"));
      const stateDir = join(home, ".local", "state", "bayma", "test");
      mkdirSync(stateDir, { recursive: true });
      const tokenFile = join(home, "token");
      writeFileSync(tokenFile, "token\n");
      const images = mkdtempSync(join(tmpdir(), "bayma-checkpoints-"));
      const name = `bayma-go-${cells}-${process.pid}-${Date.now()}`;
      try {
        await run(container("run", name, home, stateDir, tokenFile));
        const { client } = await connect(await serving(name), "token");
        const { session } = await call<{ session: { session_id: string } }>(
          client,
          "session.create",
          { runtime: "go", title: "sandbox-go", cwd: home },
        );
        for (let cell = 0; cell < cells; cell++) {
          const ran = await exec(
            client,
            session.session_id,
            `var cell${cell} = ${cell}`,
          );
          expect({ cell, status: ran.status }).toEqual({ cell, status: "ok" });
        }
        await client.close();
        const id = await run([
          "docker",
          "inspect",
          "--format",
          "{{.Id}}",
          name,
        ]);
        const { pid } = JSON.parse(
          await run(["sudo", "runsc", "--root", RUNSC_ROOT, "state", id]),
        ) as { pid: number };
        const sentryAnonKiB = Number(
          /^RssAnon:\s+(\d+) kB$/m.exec(
            await run(["sudo", "cat", `/proc/${pid}/status`]),
          )?.[1],
        );
        const image = join(images, "checkpoint");
        await run([
          "sudo",
          "runsc",
          "--root",
          RUNSC_ROOT,
          "checkpoint",
          "--image-path",
          image,
          `--save-restore-exec-argv=${await hookArgv(stateDir)}`,
          id,
        ]);
        const stateBytes = Number(
          await run([
            "sudo",
            "stat",
            "--format=%s",
            join(image, "checkpoint.img"),
          ]),
        );
        console.log(
          `after ${cells} Go cells: a state file of ${stateBytes} bytes, the Sentry's own memory ${sentryAnonKiB} KiB`,
        );
        return stateBytes;
      } finally {
        console.log(await logs(name));
        await run(["docker", "rm", "--force", name]).catch(() => undefined);
        await run(["sudo", "rm", "-rf", images, home]).catch((error) =>
          console.error(error),
        );
      }
    };
    // Each cell is a plugin of 2 to 4 MB, which the host keeps mapped: one
    // deleted would be copied into every save's state whole.
    const growth = (await saveAfter(GO_CELLS)) - (await saveAfter(1));
    expect(growth).toBeLessThan(32 * 1024 * 1024);
  },
  TEST_TIMEOUT_MS,
);

// gVisor's /proc has no smaps_rollup, and its status no RssAnon or VmSwap: the
// budget reads a host's memory from its smaps there, and a Go host that comes
// to hold 256 MiB of its own more than it started with, past a budget of 96
// MiB, is started again from the session's checkpoint, the next exec told why.
test(
  "a Go host in bayma's sandbox past the runtime memory budget is started again from its checkpoint, the next exec told why",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "bayma-sandbox-"));
    const stateDir = join(home, ".local", "state", "bayma", "test");
    mkdirSync(stateDir, { recursive: true });
    const tokenFile = join(home, "token");
    writeFileSync(tokenFile, "token\n");
    const name = `bayma-budget-${process.pid}-${Date.now()}`;
    try {
      await run(
        container("run", name, home, stateDir, tokenFile, [
          "--runtime-memory-budget-mb",
          "96",
        ]),
      );
      const { client } = await connect(await serving(name), "token");
      const { session } = await call<{ session: { session_id: string } }>(
        client,
        "session.create",
        { runtime: "go", title: "sandbox-budget", cwd: home },
      );
      const first = await exec(
        client,
        session.session_id,
        "bayma_write_checkpoint(41)\nvar held = make([]byte, 256<<20)\nfor i := range held {\n\theld[i] = 1\n}\nos.Getpid()",
      );
      expect(first.status).toBe("ok");
      expect(first.notice).toBeUndefined();
      const second = await exec(
        client,
        session.session_id,
        'import "fmt"\nvar answer int\nbayma_read_checkpoint(&answer)\nfmt.Sprintf("%d %d", answer+1, os.Getpid())',
      );
      expect(second.status).toBe("ok");
      expect(second.notice ?? "").toMatch(
        /^bayma: this session's runtime came to hold \d+ MiB more than it held as it started, past the server's runtime memory budget of 96 MiB, as it keeps each cell's plugin loaded, which Go never unloads, so it was started again from its checkpoint: only its checkpointed state survived, and the rest of its live state is gone\.$/,
      );
      const [answer, pid] = second.result_text
        .replaceAll('"', "")
        .trim()
        .split(" ");
      expect(answer).toBe("42");
      expect(pid).not.toBe(first.result_text.trim());
      expect(await logs(name)).not.toContain("says nothing of its memory");
      await client.close();
    } finally {
      console.log(await logs(name));
      await run(["docker", "rm", "--force", name]).catch(() => undefined);
      await run(["sudo", "rm", "-rf", home]).catch((error) =>
        console.error(error),
      );
    }
  },
  TEST_TIMEOUT_MS,
);
