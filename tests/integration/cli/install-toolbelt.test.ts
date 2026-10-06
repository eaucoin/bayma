import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOOLBELT_DIR, TOOLBELT_VERSION_FILE, toolbeltPath } from "@bayma/core";
import { processEnvironment } from "../../support/mcp-stdio-client.ts";
import { writePayload } from "../../support/payload.ts";
import { launchSpec } from "../../support/runtimes.ts";
import { withTempDir } from "../../support/temp.ts";

// `bayma install-toolbelt`, as a setup step runs it: it says on stderr how
// the install goes, and its status says whether the toolbelt is installed.

const TEST_TIMEOUT_MS = 60_000;

async function bayma(
  args: string[],
  env: Record<string, string>,
): Promise<{ status: number; stdout: string; stderr: string }> {
  const launch = launchSpec();
  const child = Bun.spawn([launch.command, ...launch.args, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status: await child.exited, stdout, stderr };
}

/** The environment bayma runs with, with a payload in `dir`. */
function environment(dir: string): Record<string, string> {
  const payload = writePayload(join(dir, "payload"));
  mkdirSync(join(payload, TOOLBELT_DIR));
  return {
    ...processEnvironment(),
    BAYMA_PAYLOAD_DIR: payload,
    XDG_DATA_HOME: join(dir, "data"),
  };
}

test(
  "install-toolbelt installs the toolbelt, or finds it current, and says so",
  async () => {
    await withTempDir(async (dir) => {
      const env = environment(dir);
      const target = toolbeltPath(env);

      expect(await bayma(["install-toolbelt"], env)).toEqual({
        status: 0,
        stdout: "",
        stderr: [
          `bayma: installing the 9.9.9 toolbelt at ${target}`,
          `bayma: installed the 9.9.9 toolbelt at ${target}`,
          "",
        ].join("\n"),
      });
      expect(await Bun.file(join(target, TOOLBELT_VERSION_FILE)).text()).toBe(
        "9.9.9\n",
      );

      // What an install killed while copying left is removed.
      const left = join(dirname(target), "toolbelt.Ab12Cd");
      mkdirSync(left);
      expect(await bayma(["install-toolbelt"], env)).toEqual({
        status: 0,
        stdout: "",
        stderr: [
          `bayma: removed ${left}, which an interrupted install left`,
          `bayma: the toolbelt at ${target} is current`,
          "",
        ].join("\n"),
      });
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "install-toolbelt fails with a message where it cannot install the toolbelt",
  async () => {
    await withTempDir(async (dir) => {
      const env = environment(dir);
      // Where the data root would be is a file.
      writeFileSync(join(dir, "file"), "");
      const blocked = { ...env, XDG_DATA_HOME: join(dir, "file") };

      const failed = await bayma(["install-toolbelt"], blocked);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toStartWith(
        `Error: installing the toolbelt at ${toolbeltPath(blocked)} failed: ENOTDIR`,
      );

      const { BAYMA_PAYLOAD_DIR: _, ...unset } = env;
      const unnamed = await bayma(["install-toolbelt"], unset);
      expect(unnamed.status).toBe(1);
      expect(unnamed.stderr).toStartWith("Error: BAYMA_PAYLOAD_DIR is not set");

      const extra = await bayma(["install-toolbelt", "--force", "yes"], env);
      expect(extra.status).toBe(1);
      expect(extra.stderr).toStartWith("Error: unknown option --force");
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "help lists install-toolbelt",
  async () => {
    const help = await bayma(["help"], processEnvironment());
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("\n  install-toolbelt\n");
  },
  TEST_TIMEOUT_MS,
);
