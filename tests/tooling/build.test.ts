import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { build, packageManifest } from "../../tooling/src/build.ts";
import { withTempDir } from "../support/temp.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");

test("the server's manifest is packages/server and carries the version", () => {
  const manifest = packageManifest(repoRoot);
  expect(manifest.name).toBe("@bayma/server");
  expect(manifest.private).toBe(true);
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("the bundle's sandbox hook runs its entry alone, no chunk of the server's beside it, which every other command imports", async () => {
  await withTempDir(async (dir) => {
    const { bundle } = await build(repoRoot, join(dir, "dist"));
    // What the hook loads, a few KB of the server's MBs.
    expect(statSync(bundle).size).toBeLessThan(64 * 1024);
    // The entry alone, as the hook loads it: told the server's mode on its socket, it is answered.
    const alone = join(dir, "alone");
    mkdirSync(alone);
    cpSync(bundle, join(alone, "bayma.js"));
    const stateDir = join(dir, "state");
    mkdirSync(stateDir);
    const asked: string[] = [];
    const server = createServer((socket) =>
      socket.on("data", (request) => {
        asked.push(request.toString());
        socket.end("ok\n");
      }),
    );
    await new Promise<void>((listening) =>
      server.listen(join(stateDir, "sandbox-hook.sock"), listening),
    );
    try {
      // Run beside the server, as its answer comes from this process.
      const hook = await new Promise<{ status: number | null; stderr: string }>(
        (ran) => {
          const child = spawn(
            "node",
            [join(alone, "bayma.js"), "sandbox-hook", "--state-dir", stateDir],
            {
              env: {
                ...process.env,
                GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE: "resume",
              },
            },
          );
          let stderr = "";
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
          child.on("close", (status) => ran({ status, stderr }));
        },
      );
      expect(hook).toEqual({ status: 0, stderr: "" });
      expect(asked).toEqual(["resume\n"]);
    } finally {
      server.close();
    }
    // Any other command needs the chunks the entry left out.
    const version = spawnSync("node", [join(alone, "bayma.js"), "version"], {
      encoding: "utf8",
    });
    expect(version.status).not.toBe(0);
    expect(version.stderr).toContain("Cannot find module");
  });
});
