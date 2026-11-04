import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createBunTransport } from "@bayma/runtime-bun";
import { withTempDir } from "../../support/temp.ts";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(25);
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

test.serial("transport shutdown terminates child REPLs", async () => {
  await withTempDir(async (dir) => {
    const scratchDir = (sessionId: string) => {
      const path = join(dir, "scratch", sessionId);
      mkdirSync(path, { recursive: true });
      return path;
    };
    const transport = createBunTransport();
    const first = await transport.startSession({
      sessionId: "sess_one",
      title: "one",
      cwd: dir,
      cols: 120,
      rows: 40,
      scratchDir: scratchDir("sess_one"),
    });
    const second = await transport.startSession({
      sessionId: "sess_two",
      title: "two",
      cwd: dir,
      cols: 120,
      rows: 40,
      scratchDir: scratchDir("sess_two"),
    });

    await transport.waitForInitialPrompt(first);
    await transport.waitForInitialPrompt(second);

    expect(first.pid).toBeGreaterThan(0);
    expect(second.pid).toBeGreaterThan(0);
    expect(processExists(first.pid)).toBe(true);
    expect(processExists(second.pid)).toBe(true);

    await transport.shutdown();

    await waitForProcessExit(first.pid);
    await waitForProcessExit(second.pid);
  });
});

test.serial(
  "a Bun runtime collects its garbage whole as asked, at its prompt",
  async () => {
    await withTempDir(async (dir) => {
      const transport = createBunTransport();
      const handle = await transport.startSession({
        sessionId: "sess_collect",
        title: "collect",
        cwd: dir,
        cols: 120,
        rows: 40,
        scratchDir: dir,
      });
      let output = "";
      await transport.subscribe(handle, (chunk) => {
        output += Buffer.from(chunk).toString();
      });
      try {
        await transport.waitForInitialPrompt(handle);
        // Small objects only weak references hold, which no collection an
        // allocation sets off takes before a full one does.
        await transport.write(
          handle,
          "globalThis.held = Array.from({ length: 20 }, (_, at) => new WeakRef({ at })); void 0\n",
        );
        await transport.collectGarbage!(handle, 5_000);
        await transport.write(
          handle,
          'process.stdout.write("held " + held.filter((ref) => ref.deref() !== undefined).length + "\\n"); void 0\n',
        );
        let held: RegExpExecArray | null = null;
        for (let wait = 0; wait < 200 && !held; wait += 1) {
          await sleep(25);
          held = /held (\d+)\n/.exec(output);
        }
        expect(Number(held?.[1])).toBeLessThan(10);
      } finally {
        await transport.shutdown();
      }
    });
  },
);
