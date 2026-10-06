import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctorSuccessOutput } from "@bayma/core";
import { setTimeout as sleep } from "node:timers/promises";
import {
  McpStdioClient,
  processEnvironment,
  waitForSettledExec,
  type ExecSnapshot,
} from "../support/mcp-stdio-client.ts";
import {
  FAKE_MCP_CLIENT_LOG,
  fakeMcpClientRuns,
  writeFakeMcpClients,
} from "../support/fake-mcp-clients.ts";
import { nodeExecutable } from "../support/runtimes.ts";

// The bayma package as its users run it: packed by npm from what `bun run
// build` left in packages/cli/dist, installed as npx installs it, and run in
// a home of its own against the image `bun run image` builds, which
// BAYMA_IMAGE names, with fake claude and codex commands on PATH.

const repoRoot = resolve(import.meta.dir, "..", "..");
const version = JSON.parse(
  readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8"),
).version as string;
const IMAGE = `bayma:${version}`;
const IMAGE_TIMEOUT_MS = 1_800_000;

async function run(
  command: string[],
  env: Record<string, string>,
  cwd = repoRoot,
): Promise<{ exitCode: number; stdout: string; output: string }> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, output: stdout + stderr };
}

/** The containers, running or not, that mount `home`: those launched for it. */
async function containersOf(home: string): Promise<string> {
  return (
    await run(
      ["docker", "ps", "--all", "--quiet", "--filter", `volume=${home}`],
      processEnvironment(),
    )
  ).stdout.trim();
}

async function expectNoContainers(home: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while ((await containersOf(home)) !== "" && Date.now() < deadline)
    await sleep(250);
  expect(await containersOf(home)).toBe("");
}

test.serial(
  "npx bayma sets bayma up, launches its stdio server, checks it, and takes it off again",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "bayma-cli-"));
    try {
      const bin = join(home, "bin");
      writeFakeMcpClients(bin);
      const log = join(home, "clients.log");
      const env = {
        ...processEnvironment(),
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        BAYMA_IMAGE: IMAGE,
        [FAKE_MCP_CLIENT_LOG]: log,
      };

      const packed = await run(
        ["npm", "pack", "--json", "--pack-destination", home],
        env,
        join(repoRoot, "packages", "cli"),
      );
      expect(packed.exitCode).toBe(0);
      const [{ filename }] = JSON.parse(packed.stdout) as {
        filename: string;
      }[];
      const prefix = join(home, "npm");
      const installed = await run(
        [
          "npm",
          "install",
          "--global",
          "--prefix",
          prefix,
          "--no-audit",
          "--no-fund",
          join(home, filename),
        ],
        env,
      );
      expect(installed.exitCode).toBe(0);
      const bayma = join(prefix, "bin", "bayma");

      const init = await run([bayma, "init"], env, home);
      expect({ exitCode: init.exitCode, output: init.output }).toMatchObject({
        exitCode: 0,
      });
      const cli = join(
        home,
        ".local",
        "share",
        "bayma",
        "cli",
        version,
        "bayma.js",
      );
      expect(existsSync(cli)).toBe(true);
      const runs = fakeMcpClientRuns(log);
      expect(runs).toHaveLength(4);
      expect(runs[1]).toMatch(
        new RegExp(
          `^claude mcp add --scope user bayma -- /\\S+/node ${cli} mcp-stdio$`,
        ),
      );
      expect(runs[3]).toMatch(
        new RegExp(`^codex mcp add bayma -- /\\S+/node ${cli} mcp-stdio$`),
      );
      expect(
        readFileSync(
          join(
            home,
            ".local",
            "share",
            "bayma",
            "toolbelt",
            ".bayma-toolbelt-version",
          ),
          "utf8",
        ).trim(),
      ).toBe(version);

      // MCP over the launcher an MCP client runs; closing the client closes
      // the launcher's stdin, and so the server's, which ends it.
      const client = await McpStdioClient.launch(
        {
          command: nodeExecutable(),
          args: [cli],
          binaryLabel: "bayma launcher",
        },
        { stateDir: join(home, ".local", "state", "bayma", "e2e"), env },
      );
      try {
        const created = await client.callTool<{
          session: { session_id: string };
        }>("session.create", { runtime: "bun", title: "launcher", cwd: home });
        const sessionId = created.session.session_id;
        const submitted = await client.callTool<ExecSnapshot>("exec", {
          session_id: sessionId,
          code: "20 + 22",
          yield_time_ms: 1_000,
        });
        const settled = await waitForSettledExec(client, sessionId, submitted, {
          timeoutMs: 240_000,
        });
        expect({
          status: settled.status,
          result: settled.result_text?.trim(),
        }).toEqual({
          status: "ok",
          result: "42",
        });
      } finally {
        await client.close();
      }
      await expectNoContainers(home);

      // A launcher whose stdin ends exits as its server does, with its status.
      const launcher = Bun.spawn([nodeExecutable(), cli, "mcp-stdio"], {
        cwd: home,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      await sleep(2_000);
      launcher.stdin.end();
      expect(await launcher.exited).toBe(0);
      await expectNoContainers(home);

      const doctor = await run(
        [bayma, "doctor", "--runtime", "bun", "--format", "json"],
        env,
        home,
      );
      expect({ exitCode: doctor.exitCode, stdout: doctor.stdout }).toEqual({
        exitCode: 0,
        stdout: doctorSuccessOutput(["bun"], undefined) + "\n",
      });

      const status = await run([bayma, "status"], env, home);
      expect(status.exitCode).toBe(0);
      for (const line of [
        `bayma ${version}`,
        `image: ${IMAGE}`,
        `toolbelt: ${version} at ${join(home, ".local", "share", "bayma", "toolbelt")}`,
        `installed for MCP clients: ${version}`,
      ])
        expect(status.stdout).toContain(line);

      const uninstall = await run([bayma, "uninstall", "--purge"], env, home);
      expect({
        exitCode: uninstall.exitCode,
        output: uninstall.output,
      }).toMatchObject({
        exitCode: 0,
      });
      expect(fakeMcpClientRuns(log).slice(4)).toEqual([
        "claude mcp remove --scope user bayma",
        "codex mcp remove bayma",
      ]);
      expect(existsSync(join(home, ".local", "share", "bayma"))).toBe(false);
      expect(existsSync(join(home, ".local", "state", "bayma"))).toBe(false);
      // The image BAYMA_IMAGE names was never pulled, so it stays.
      expect(
        (await run(["docker", "image", "inspect", IMAGE], processEnvironment()))
          .exitCode,
      ).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  IMAGE_TIMEOUT_MS,
);
