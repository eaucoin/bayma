import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
  holdingFiles,
  markSandboxResumed,
  parseSandboxHookMode,
  runSandboxHook,
  sandboxHookSocket,
  sandboxSaved,
  serveSandboxHook,
  type SandboxHookHandlers,
} from "@bayma/core";
import { SOCKET_TEMP_ROOT, withTempDir } from "../../../support/temp.ts";

afterEach(() => {
  markSandboxResumed();
  jest.useRealTimers();
});

/** A temporary state directory short enough for the hook's socket, wherever TMPDIR is. */
function withHookDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir(fn, SOCKET_TEMP_ROOT) as Promise<T>;
}

/** Handlers that record what they were asked, in order, and whether the server was saved then. */
function recording(): { calls: string[]; handlers: SandboxHookHandlers } {
  const calls: string[] = [];
  const saved = () => (sandboxSaved() ? "saved" : "running");
  return {
    calls,
    handlers: {
      save: async () => {
        calls.push(`save, ${saved()}`);
      },
      restore: async (savedAtMs) => {
        calls.push(`restore from ${typeof savedAtMs}, ${saved()}`);
      },
    },
  };
}

/** Lets the promise callbacks a fake clock's timers set off run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

/** What the hook's server answers `request`, sent as is. */
function ask(dir: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answer = "";
    const socket = net.connect(sandboxHookSocket(dir), () =>
      socket.write(request),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (answer += chunk));
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
  });
}

test("each mode the hook is run in reaches the server, saved until it runs on", async () => {
  await withHookDir(async (dir) => {
    const { calls, handlers } = recording();
    const stop = await serveSandboxHook(dir, handlers);
    try {
      await runSandboxHook(dir, "save");
      expect(sandboxSaved()).toBe(true);
      await runSandboxHook(dir, "restore");
      expect(sandboxSaved()).toBe(false);
      await runSandboxHook(dir, "save");
      await runSandboxHook(dir, "resume");
      expect(sandboxSaved()).toBe(false);
      expect(calls).toEqual([
        "save, saved",
        "restore from number, saved",
        "save, saved",
      ]);
    } finally {
      await stop();
    }
    expect(existsSync(sandboxHookSocket(dir))).toBe(false);
  });
});

test("a save waits for the work that holds files open to end, and its files to close, before it saves", async () => {
  await withHookDir(async (dir) => {
    const { calls, handlers } = recording();
    const stop = await serveSandboxHook(dir, handlers);
    let finish = () => {};
    const copying = holdingFiles(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            calls.push("copied");
            resolve();
          };
        }),
    );
    try {
      const saving = runSandboxHook(dir, "save");
      while (!sandboxSaved())
        await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toEqual([]);
      finish();
      await saving;
      await copying;
      expect(calls).toEqual(["copied", "save, saved"]);
    } finally {
      finish();
      await stop();
    }
  });
});

test("a restore of a server not saved, or saved and resumed since, is refused", async () => {
  await withHookDir(async (dir) => {
    const stop = await serveSandboxHook(dir, recording().handlers);
    try {
      const refusal = `the bayma server of ${dir} could not restore: the server was not saved, to be restored`;
      await expect(runSandboxHook(dir, "restore")).rejects.toThrow(refusal);
      await runSandboxHook(dir, "save");
      await runSandboxHook(dir, "resume");
      await expect(runSandboxHook(dir, "restore")).rejects.toThrow(refusal);
    } finally {
      await stop();
    }
  });
});

test("a save that fails leaves the server running, and the hook fails with why", async () => {
  await withHookDir(async (dir) => {
    const { calls, handlers } = recording();
    const stop = await serveSandboxHook(dir, {
      ...handlers,
      save: async () => {
        throw new Error("storage is gone");
      },
    });
    try {
      await expect(runSandboxHook(dir, "save")).rejects.toThrow(
        `the bayma server of ${dir} could not save: storage is gone`,
      );
      expect(sandboxSaved()).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      await stop();
    }
  });
});

test("a save no restore or resume follows is given up on, and said so", async () => {
  await withHookDir(async (dir) => {
    jest.useFakeTimers();
    const { calls, handlers } = recording();
    const stop = await serveSandboxHook(dir, handlers);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      await runSandboxHook(dir, "save");
      jest.advanceTimersByTime(10 * 60_000 - 1_000);
      await settle();
      expect(sandboxSaved()).toBe(true);
      jest.advanceTimersByTime(1_000);
      await settle();
      expect(sandboxSaved()).toBe(false);
      expect(calls).toEqual(["save, saved"]);
      expect(stderr).toHaveBeenCalledWith(
        "bayma: the server runs on, saved 600 s ago and neither restored nor resumed since\n",
      );
    } finally {
      stderr.mockRestore();
      await stop();
    }
  });
});

test("a second save is given up on only once it, too, is followed by nothing", async () => {
  await withHookDir(async (dir) => {
    jest.useFakeTimers();
    const stop = await serveSandboxHook(dir, recording().handlers);
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );
    try {
      await runSandboxHook(dir, "save");
      jest.advanceTimersByTime(5 * 60_000);
      await runSandboxHook(dir, "save");
      // The first save's expiry.
      jest.advanceTimersByTime(5 * 60_000);
      await settle();
      expect(sandboxSaved()).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5 * 60_000);
      await settle();
      expect(sandboxSaved()).toBe(false);
    } finally {
      stderr.mockRestore();
      await stop();
    }
  });
});

test("the hook's server answers no request longer than a mode", async () => {
  await withHookDir(async (dir) => {
    const { calls, handlers } = recording();
    const stop = await serveSandboxHook(dir, handlers);
    try {
      expect(await ask(dir, "s".repeat(64))).toBe(
        "the sandbox hook's request is too long\n",
      );
      // Ten characters, nineteen bytes with the newline.
      expect(await ask(dir, `${"é".repeat(9)}\n`)).toBe(
        "the sandbox hook's request is too long\n",
      );
      expect(await ask(dir, "checkpoint\n")).toBe(
        "the sandbox hook's mode must be save, restore, resume, not checkpoint\n",
      );
      expect(calls).toEqual([]);
    } finally {
      await stop();
    }
  });
});

test("the hook's server closes a connection that sends no request", async () => {
  await withHookDir(async (dir) => {
    const { calls, handlers } = recording();
    const stop = await serveSandboxHook(dir, handlers);
    try {
      const connectedAtMs = Date.now();
      expect(await ask(dir, "")).toBe("");
      expect(Date.now() - connectedAtMs).toBeGreaterThanOrEqual(4_900);
      expect(calls).toEqual([]);
    } finally {
      await stop();
    }
  });
}, 10_000);

test("the hook fails when no server serves the state directory", async () => {
  await withHookDir(async (dir) => {
    await expect(runSandboxHook(dir, "save")).rejects.toThrow(
      `no bayma server answers on ${sandboxHookSocket(dir)}`,
    );
  });
});

test("a state directory too deep for a Unix socket serves no hook, and says so", async () => {
  await withHookDir(async (root) => {
    const dir = join(root, "d".repeat(100));
    mkdirSync(dir);
    const reports: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation(
      (chunk) => {
        reports.push(String(chunk));
        return true;
      },
    );
    try {
      const stop = await serveSandboxHook(dir, recording().handlers);
      await stop();
    } finally {
      stderr.mockRestore();
    }
    expect(reports).toEqual([
      `bayma: no sandbox hook is served: its socket, ${sandboxHookSocket(dir)}, would be longer than a Unix socket's path may be\n`,
    ]);
    expect(existsSync(sandboxHookSocket(dir))).toBe(false);
  });
});

test("the hook's mode is one gVisor names", () => {
  expect(parseSandboxHookMode("restore")).toBe("restore");
  for (const mode of [undefined, "", "Save", "checkpoint"])
    expect(() => parseSandboxHookMode(mode)).toThrow(
      "the sandbox hook's mode must be save, restore, resume",
    );
});
