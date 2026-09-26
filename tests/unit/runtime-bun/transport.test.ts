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
