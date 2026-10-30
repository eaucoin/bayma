import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  KILLED_FIRST_FOR_MEMORY,
  startToolbeltInstall,
  TOOLBELT_DIR,
  TOOLBELT_VERSION_FILE,
  toolbeltPath,
  type PathEnvironment,
} from "@bayma/core";
import { launchMcpHttpServer } from "../../support/mcp-http-client.ts";
import {
  McpStdioClient,
  processEnvironment,
} from "../../support/mcp-stdio-client.ts";
import {
  holdToolbeltInstallLock,
  writePayload,
} from "../../support/payload.ts";
import { launchSpec, runSandboxHookCommand } from "../../support/runtimes.ts";
import { withTempDir } from "../../support/temp.ts";

// A server whose toolbelt is not installed yet answers at once, installing it
// in the background, in a process of its own, and stops the install as it
// shuts down, leaving nothing of it behind.

const TEST_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 20_000;
// So many that copying them outlasts what a test does meanwhile.
const MANY_FILES = 20_000;

/**
 * The environment of a server started from a payload, in `dir`, whose
 * toolbelt holds `files` files more, with nothing installed yet.
 */
function serverEnvironment(dir: string, files: number): Record<string, string> {
  const payload = writePayload(join(dir, "payload"));
  const bulk = join(payload, TOOLBELT_DIR, "bulk");
  mkdirSync(bulk, { recursive: true });
  for (let index = 0; index < files; index += 1)
    writeFileSync(join(bulk, String(index)), "");
  return {
    ...processEnvironment(),
    BAYMA_PAYLOAD_DIR: payload,
    XDG_DATA_HOME: join(dir, "data"),
  };
}

/** The directories installs are assembling toolbelts in, beside its path. */
function staging(env: PathEnvironment): string[] {
  const parent = dirname(toolbeltPath(env));
  return existsSync(parent)
    ? readdirSync(parent).filter((name) => name.startsWith(`${TOOLBELT_DIR}.`))
    : [];
}

/**
 * The processes installing the toolbelt at the toolbelt path of `env`, as
 * `bayma install-toolbelt` does for a server.
 */
function installers(env: PathEnvironment): number[] {
  const read = (pid: string, file: string) => {
    try {
      return readFileSync(join("/proc", pid, file), "utf8").split("\0");
    } catch {
      return [];
    }
  };
  return readdirSync("/proc")
    .filter(
      (pid) =>
        /^\d+$/.test(pid) &&
        read(pid, "cmdline").includes("install-toolbelt") &&
        read(pid, "environ").includes(`XDG_DATA_HOME=${env.XDG_DATA_HOME}`),
    )
    .map(Number);
}

/** How many files the copies being assembled beside the toolbelt path hold. */
function copied(env: PathEnvironment): number {
  const parent = dirname(toolbeltPath(env));
  return staging(env).reduce(
    (count, name) =>
      count +
      (existsSync(join(parent, name, "bulk"))
        ? readdirSync(join(parent, name, "bulk")).length
        : 0),
    0,
  );
}

function installed(env: PathEnvironment): boolean {
  return existsSync(join(toolbeltPath(env), TOOLBELT_VERSION_FILE));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out until ${what}`);
    await sleep(10);
  }
}

test(
  "a server answers while its toolbelt installs, and installs it",
  async () => {
    await withTempDir(async (dir) => {
      const env = serverEnvironment(dir, 0);
      // Another bayma installing holds this server's install back.
      const release = holdToolbeltInstallLock(env);
      const client = await McpStdioClient.connect({ env });
      try {
        expect(await client.listTools()).toContain("exec");
        await until(
          () => client.serverOutput().includes("waiting for another bayma"),
          "the server waits for the other install",
        );
        expect(installed(env)).toBe(false);

        release();
        await until(() => installed(env), "the toolbelt is installed");
        expect(await client.listTools()).toContain("exec");
      } finally {
        release();
        await client.close();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a server that stops while copying its toolbelt stops the copy and removes it",
  async () => {
    await withTempDir(async (dir) => {
      const env = serverEnvironment(dir, MANY_FILES);
      const client = await McpStdioClient.connect({ env });
      try {
        await until(() => staging(env).length > 0, "the toolbelt is copied");
        // The copy leaves the server free to answer.
        expect(await client.listTools()).toContain("exec");
      } finally {
        await client.close();
      }

      await until(() => staging(env).length === 0, "the copy is removed");
      expect(existsSync(toolbeltPath(env))).toBe(false);
      expect(client.serverOutput()).toContain(
        "bayma: stopped installing the toolbelt, which the next start installs",
      );
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a server over HTTP told to stop while copying its toolbelt stops the copy and removes it",
  async () => {
    await withTempDir(async (dir) => {
      const env = serverEnvironment(dir, MANY_FILES);
      // It answers before the copy is done.
      const server = await launchMcpHttpServer({ env });
      try {
        await until(() => staging(env).length > 0, "the toolbelt is copied");

        process.kill(server.child.pid!, "SIGTERM");
        await until(
          () => server.child.exitCode !== null,
          "the server has shut down",
        );
        expect(server.child.exitCode).toBe(0);
        expect(staging(env)).toEqual([]);
        expect(existsSync(toolbeltPath(env))).toBe(false);
      } finally {
        await server.close();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

for (const runsOn of ["resume", "restore"] as const)
  test(
    `a save stops the toolbelt's install, which the kernel kills before the server, and a ${runsOn} installs it again from the start`,
    async () => {
      await withTempDir(async (dir) => {
        const env = serverEnvironment(dir, MANY_FILES);
        const stateDir = join(dir, "state");
        const client = await McpStdioClient.connect({ env, stateDir });
        try {
          await until(() => copied(env) > 0, "the toolbelt is copied");
          const [installer] = installers(env);
          expect(
            readFileSync(`/proc/${installer}/oom_score_adj`, "utf8").trim(),
          ).toBe(String(KILLED_FIRST_FOR_MEMORY));

          expect(
            await runSandboxHookCommand(stateDir, "save", "arguments"),
          ).toEqual({ status: 0, stderr: "" });
          // Saved, the install's process is gone, none of its files open, and
          // nothing more is copied; what it assembled is left beside the
          // toolbelt path, for no reader to take for the toolbelt.
          expect(installers(env)).toEqual([]);
          const left = copied(env);
          expect(left).toBeLessThan(MANY_FILES);
          await sleep(200);
          expect(copied(env)).toBe(left);
          expect(installed(env)).toBe(false);

          expect(
            await runSandboxHookCommand(stateDir, runsOn, "arguments"),
          ).toEqual({ status: 0, stderr: "" });
          await until(() => installed(env), "the toolbelt is installed");
          expect(client.serverOutput()).toContain(
            "bayma: installing the toolbelt again, as the sandbox was saved while it installed",
          );
          expect(readdirSync(join(toolbeltPath(env), "bulk"))).toHaveLength(
            MANY_FILES,
          );
          expect(staging(env)).toEqual([]);
        } finally {
          await client.close();
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

test(
  "an install killed, by the kernel for its memory or otherwise, is said, and runs again",
  async () => {
    await withTempDir(async (dir) => {
      const env = serverEnvironment(dir, 0);
      // The server's cgroup, as the install's kills count in it.
      const cgroupDir = join(dir, "cgroup");
      mkdirSync(cgroupDir);
      const events = join(cgroupDir, "memory.events");
      writeFileSync(events, "oom 0\noom_kill 0\n");
      writeFileSync(join(cgroupDir, "memory.max"), `${768 * 2 ** 20}\n`);
      // Another bayma installing holds each install back until released.
      const release = holdToolbeltInstallLock(env);
      const reports: string[] = [];
      const launch = launchSpec();
      const install = startToolbeltInstall(
        { file: launch.command, args: [...launch.args, "install-toolbelt"] },
        env,
        (message) => reports.push(message),
        { retryMs: 100, cgroupDir },
      );
      const killed = async (kills: number) => {
        await until(() => installers(env).length === 1, "the install runs");
        const [installer] = installers(env);
        writeFileSync(events, `oom 1\noom_kill ${kills}\n`);
        process.kill(installer!, "SIGKILL");
        await until(
          () => !installers(env).includes(installer!),
          "the install is killed",
        );
      };
      try {
        await killed(0);
        await killed(1);
        await until(
          () => reports.length === 4 && installers(env).length === 1,
          "the install runs again",
        );
        expect(reports).toEqual([
          "bayma: the toolbelt's install was killed (SIGKILL): it is installed again in 0.1 s",
          "bayma: installing the toolbelt again",
          "bayma: the toolbelt's install ran out of its memory (768Mi) and was killed by the kernel: it is installed again in 0.1 s",
          "bayma: installing the toolbelt again",
        ]);
        release();
        await until(() => installed(env), "the toolbelt is installed");
      } finally {
        release();
        await install.stop();
      }
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "an install that fails is said, and one that has finished is left as it is when stopped",
  async () => {
    await withTempDir(async (dir) => {
      const reports: string[] = [];
      const launch = launchSpec();
      const installing = (env: Record<string, string>) =>
        startToolbeltInstall(
          { file: launch.command, args: [...launch.args, "install-toolbelt"] },
          env,
          (message) => reports.push(message),
        );
      const env = serverEnvironment(dir, 0);
      // Where the data root cannot be made, the install fails.
      writeFileSync(join(dir, "file"), "");
      const failing = installing({ ...env, XDG_DATA_HOME: join(dir, "file") });
      await until(() => reports.length > 0, "the install fails");
      await failing.stop();
      expect(reports).toEqual([
        "bayma: installing the toolbelt failed: its process exited with code 1",
      ]);

      const finishing = installing(env);
      await until(() => installed(env), "the toolbelt is installed");
      await until(() => installers(env).length === 0, "the install ends");
      await finishing.stop();
      expect(installed(env)).toBe(true);
      expect(reports).toHaveLength(1);
    });
  },
  TEST_TIMEOUT_MS,
);
