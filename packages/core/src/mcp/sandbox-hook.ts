import { Buffer } from "node:buffer";
import { realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { failureMessage } from "../errors.ts";
import {
  filesClosed,
  markSandboxResumed,
  markSandboxSaved,
  resumesWithin,
} from "../sandbox.ts";
import { inSpan, report } from "../telemetry/record.ts";

// How a host that saves the whole sandbox bayma runs in, and restores it,
// perhaps elsewhere and much later, as gVisor's runsc does, tells the server
// so: it runs `bayma sandbox-hook` in the sandbox before the save and after
// the restore (`runsc checkpoint --save-restore-exec-argv`, whose mode the
// command reads from GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE), which passes the
// mode on to the server over a Unix socket in the server's state directory.
// It needs no network, which the restored sandbox may not have yet, and no
// token, which the restore may be about to replace; the state directory's
// mode keeps it to the server's own user.

export const SANDBOX_HOOK_MODES = ["save", "restore", "resume"] as const;
export type SandboxHookMode = (typeof SANDBOX_HOOK_MODES)[number];

/** Where gVisor names the mode of the command it runs. */
export const SANDBOX_HOOK_MODE_VARIABLE = "GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE";

/**
 * What the server does at a save and at a restore, while it is saved (see
 * ../sandbox.ts). A resume, after a save that left the sandbox running or
 * failed, takes nothing of it: the server's timeouts run on as they were.
 */
export interface SandboxHookHandlers {
  /**
   * Before the sandbox is saved: put what sessions committed on storage, so
   * that falling back to their checkpoints loses nothing.
   */
  save: () => Promise<void>;
  /**
   * After the sandbox was restored from what it saved at `savedAtMs`: its
   * connections to the outside are gone, and it may serve another host.
   */
  restore: (savedAtMs: number) => Promise<void>;
}

// A Unix socket's path is at most this many bytes long.
const MAX_SOCKET_PATH_BYTES = 107;
// The longest request the hook sends: its mode, and a newline.
const MAX_REQUEST_BYTES = 16;
// The hook sends its request as soon as it connects: a connection that has
// sent none within this long is closed.
const REQUEST_TIMEOUT_MS = 5_000;
// A save that no restore or resume follows within this much of the time the
// server runs, as when its host's checkpoint failed and it ran no resume, is
// given up on: no save takes this long.
const SAVE_EXPIRY_MS = 10 * 60_000;

/** The socket the server of `stateDir` hears the hook on. */
export function sandboxHookSocket(stateDir: string): string {
  return join(stateDir, "sandbox-hook.sock");
}

export function parseSandboxHookMode(
  value: string | undefined,
): SandboxHookMode {
  if (!(SANDBOX_HOOK_MODES as readonly (string | undefined)[]).includes(value))
    throw new Error(
      `the sandbox hook's mode must be ${SANDBOX_HOOK_MODES.join(", ")}, not ${value ?? "none"}`,
    );
  return value as SandboxHookMode;
}

/**
 * Hears the hook for the server whose state directory, which it holds the
 * lease of, is `stateDir`, the span `bayma.sandbox.<mode>` recording each
 * mode's work. Returns what stops it.
 */
export async function serveSandboxHook(
  stateDir: string,
  handlers: SandboxHookHandlers,
): Promise<() => Promise<void>> {
  const path = sandboxHookSocket(stateDir);
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    report(
      `bayma: no sandbox hook is served: its socket, ${path}, would be longer than a Unix socket's path may be`,
    );
    return async () => undefined;
  }
  // When the server last saved, while it is saved.
  let savedAtMs: number | undefined;
  // How many saves the server made: a save given up on is the last one.
  let saves = 0;
  // One mode at a time, in the order they came.
  let tail = Promise.resolve();
  const queue = (work: () => Promise<void>): Promise<void> => {
    const done = tail.then(work);
    tail = done.catch(() => undefined);
    return done;
  };
  const resume = () => {
    savedAtMs = undefined;
    markSandboxResumed();
  };
  const handle = async (mode: SandboxHookMode): Promise<void> => {
    switch (mode) {
      case "save": {
        markSandboxSaved();
        try {
          await inSpan("bayma.sandbox.save", {}, async () => {
            // No file is held open by work that would move on with it.
            await filesClosed();
            await handlers.save();
          });
        } catch (error) {
          resume();
          throw error;
        }
        savedAtMs = Date.now();
        const save = ++saves;
        void resumesWithin(SAVE_EXPIRY_MS).then((resumed) => {
          if (resumed) return;
          void queue(async () => {
            // Saved again since, the server waits for that save's expiry.
            if (savedAtMs === undefined || saves !== save) return;
            report(
              `bayma: the server runs on, saved ${SAVE_EXPIRY_MS / 1000} s ago and neither restored nor resumed since`,
            );
            resume();
          });
        });
        return;
      }
      case "restore": {
        const restoredFrom = savedAtMs;
        if (restoredFrom === undefined)
          throw new Error("the server was not saved, to be restored");
        try {
          await inSpan(
            "bayma.sandbox.restore",
            {
              "bayma.sandbox.saved.duration":
                (Date.now() - restoredFrom) / 1000,
            },
            () => handlers.restore(restoredFrom),
          );
        } finally {
          resume();
        }
        return;
      }
      case "resume":
        await inSpan("bayma.sandbox.resume", {}, async () => resume());
        return;
    }
  };
  const server = net.createServer((socket) => {
    let request = Buffer.alloc(0);
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const end = request.indexOf("\n");
      if ((end === -1 ? request.length : end + 1) > MAX_REQUEST_BYTES) {
        socket.removeAllListeners("data");
        socket.setTimeout(0);
        socket.end("the sandbox hook's request is too long\n");
        return;
      }
      if (end === -1) return;
      socket.removeAllListeners("data");
      // What the mode takes may take longer than a request may.
      socket.setTimeout(0);
      queue(() =>
        handle(parseSandboxHookMode(request.subarray(0, end).toString())),
      ).then(
        () => socket.end("ok\n"),
        (error: unknown) => socket.end(`${failureMessage(error)}\n`),
      );
    });
    socket.on("error", () => socket.destroy());
  });
  // The lease on the state directory makes any socket left there a dead
  // server's.
  rmSync(path, { force: true });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(path, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return () =>
    new Promise<void>((resolveClose) => {
      server.close(() => {
        rmSync(path, { force: true });
        resolveClose();
      });
    });
}

/**
 * Tells the server of `stateDir` that its sandbox is at `mode`, and waits
 * for it to have done what that takes; throws what it could not do.
 */
export async function runSandboxHook(
  stateDir: string,
  mode: SandboxHookMode,
): Promise<void> {
  // The server's state directory is where its lease resolved it to.
  const path = sandboxHookSocket(realpathSync(resolve(stateDir)));
  const answer = await new Promise<string>((resolveAnswer, rejectAnswer) => {
    let received = "";
    const socket = net.connect(path, () => socket.write(`${mode}\n`));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += chunk;
    });
    socket.on("end", () => resolveAnswer(received));
    socket.on("error", (error) =>
      rejectAnswer(
        new Error(
          `no bayma server answers on ${path}: ${failureMessage(error)}`,
          { cause: error },
        ),
      ),
    );
  });
  if (answer !== "ok\n")
    throw new Error(
      `the bayma server of ${stateDir} could not ${mode}: ${answer.trimEnd() || "it closed the connection"}`,
    );
}
