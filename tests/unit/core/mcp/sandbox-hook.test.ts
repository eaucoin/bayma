import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
  holdingFiles,
  restoreSandboxServer,
  SandboxSaveOutlived,
  markSandboxResumed,
  parseSandboxHookMode,
  runSandboxHook,
  sandboxHookSocket,
  sandboxSaved,
  serveSandboxHook,
  type SandboxHookHandlers,
} from "@bayma/core";
import { nodeExecutable } from "../../../support/runtimes.ts";
import { SOCKET_TEMP_ROOT, withTempDir } from "../../../support/temp.ts";

/** The hook's module, as Node runs it from source. */
const SANDBOX_HOOK_MODULE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "core",
  "src",
  "mcp",
  "sandbox-hook.ts",
);

afterEach(() => {
  markSandboxResumed();
  jest.useRealTimers();
});

/** A temporary state directory short enough for the hook's socket, wherever TMPDIR is. */
function withHookDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir(fn, SOCKET_TEMP_ROOT) as Promise<T>;
}

/** What a save of the test's catches. */
const CAUGHT = {
  generation: 7,
  running: [{ sessionId: "sess_a", execId: "exec_b" }],
};

/** Handlers that record what they were asked, in order, and whether the server was saved then. */
function recording(): { calls: string[]; handlers: SandboxHookHandlers } {
  const calls: string[] = [];
  const saved = () => (sandboxSaved() ? "saved" : "running");
  return {
    calls,
    handlers: {
      save: async () => {
        calls.push(`save, ${saved()}`);
        return CAUGHT;
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
      // A save answers what it caught; the others nothing.
      expect(JSON.parse((await runSandboxHook(dir, "save"))!)).toEqual(CAUGHT);
      expect(sandboxSaved()).toBe(true);
      expect(await runSandboxHook(dir, "restore")).toBeUndefined();
      expect(sandboxSaved()).toBe(false);
      await runSandboxHook(dir, "save");
      expect(await runSandboxHook(dir, "resume")).toBeUndefined();
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
        "the sandbox hook's mode must be save, restore, resume, stop, not checkpoint\n",
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

test("the hook's server answers a request that came while it did not run, as a restored server waiting for its pages does not, however long that was", async () => {
  await withHookDir(async (dir) => {
    // The server, under Node, as bayma runs: told to, it runs no more for
    // longer than a request may take to come, in a turn of its event loop
    // after which Node runs its timers before it reads what came meanwhile.
    const server = Bun.spawn(
      [
        nodeExecutable(),
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        `const { serveSandboxHook } = await import(${JSON.stringify(SANDBOX_HOOK_MODULE)});
        await serveSandboxHook(${JSON.stringify(dir)}, { save: async () => ({ generation: 0, running: [] }), restore: async () => {} });
        console.log("serving");
        process.stdin.on("data", () =>
          setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_500)),
        );`,
      ],
      { stdin: "pipe", stdout: "pipe" },
    );
    try {
      const said = server.stdout.getReader();
      for (let out = ""; !out.includes("serving\n");)
        out += new TextDecoder().decode((await said.read()).value);
      const socket = net.connect(sandboxHookSocket(dir));
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (answer += chunk));
      const ended = new Promise<void>((resolve) => {
        socket.on("close", () => resolve());
        socket.on("error", () => undefined);
      });
      await new Promise((resolve) => socket.once("connect", resolve));
      // Taken, the server stops running; the hook's request comes meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 200));
      server.stdin.write("stall\n");
      server.stdin.flush();
      await new Promise((resolve) => setTimeout(resolve, 500));
      socket.write("resume\n");
      await ended;
      expect(answer).toBe("ok\n");
    } finally {
      server.kill();
      await server.exited;
    }
  });
}, 20_000);

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

test("a restored server tells its sessions, then installs the toolbelt again, even where telling them fails, and does neither where the fence refuses", () => {
  const calls: string[] = [];
  const server = (refuses: boolean, fails: boolean) => ({
    manager: {
      assertSandboxRestorable: () => {
        calls.push("fence");
        if (refuses) throw new Error("the state directory has moved on");
      },
      sandboxRestored: (savedAtMs: number) => {
        calls.push(`sessions told of ${savedAtMs}`);
        if (fails) throw new Error("the notices were not persisted");
      },
    },
    toolbelt: { restored: () => void calls.push("toolbelt") },
  });

  restoreSandboxServer(server(false, false), 7);
  expect(calls.splice(0)).toEqual(["fence", "sessions told of 7", "toolbelt"]);
  expect(() => restoreSandboxServer(server(false, true), 7)).toThrow(
    "the notices were not persisted",
  );
  expect(calls.splice(0)).toEqual(["fence", "sessions told of 7", "toolbelt"]);
  // Refused, the restore fails, and the server it would have restored does
  // nothing.
  expect(() => restoreSandboxServer(server(true, false), 7)).toThrow(
    "the state directory has moved on",
  );
  expect(calls.splice(0)).toEqual(["fence"]);
});

test("a server restored from a save its state directory moved on from stays saved, and one whose restore fails otherwise runs on", async () => {
  await withHookDir(async (dir) => {
    for (const [failure, staysSaved] of [
      [
        new SandboxSaveOutlived(
          "the state directory has moved on since this save",
        ),
        true,
      ],
      [new Error("the notices were not persisted"), false],
    ] as const) {
      const { handlers } = recording();
      const stop = await serveSandboxHook(dir, {
        ...handlers,
        restore: async () => {
          throw failure;
        },
      });
      try {
        await runSandboxHook(dir, "save");
        await expect(runSandboxHook(dir, "restore")).rejects.toThrow(
          failure.message,
        );
        expect(sandboxSaved()).toBe(staysSaved);
      } finally {
        await stop();
        markSandboxResumed();
      }
    }
  });
});

test("a stop asked while the server is saved waits for it to run on, and a restore from the save leaves it as the old pod's", async () => {
  await withHookDir(async (dir) => {
    for (const after of ["resume", "restore", "none"] as const) {
      const { calls, handlers } = recording();
      const stopCalls: string[] = [];
      handlers.stop = {
        restored: () => stopCalls.push("restored"),
        resumed: () => stopCalls.push("resumed"),
        goOn: (reason) => stopCalls.push(`goOn: ${reason}`),
      };
      const stop = await serveSandboxHook(dir, handlers);
      try {
        if (after !== "none") {
          await runSandboxHook(dir, "save");
          // Saved, the stop waits: going on would write over the save.
          await runSandboxHook(dir, "stop");
          expect(stopCalls).toEqual([]);
          await runSandboxHook(dir, after);
          expect(stopCalls).toEqual(
            after === "resume"
              ? [
                  "resumed",
                  "goOn: sandbox-hook stop asked it to as the server was saved",
                ]
              : ["restored"],
          );
          if (after === "restore") {
            // The old pod's stop asks nothing of the restored server: a save
            // of it the server then runs on from goes on with none.
            await runSandboxHook(dir, "save");
            await runSandboxHook(dir, "resume");
            expect(stopCalls).toEqual(["restored", "resumed"]);
          }
        } else {
          // Running, it goes on at once.
          await runSandboxHook(dir, "stop");
          expect(stopCalls).toEqual(["goOn: sandbox-hook stop asked it to"]);
        }
        expect(calls.length).toBe({ resume: 1, restore: 3, none: 0 }[after]);
      } finally {
        await stop();
        markSandboxResumed();
      }
    }
  });
});
