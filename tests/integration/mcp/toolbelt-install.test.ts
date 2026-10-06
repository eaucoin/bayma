import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
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
import { withTempDir } from "../../support/temp.ts";

// A server whose toolbelt is not installed yet answers at once, installing it
// in the background, and stops the install as it shuts down, leaving nothing
// of it behind.

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
