import { Buffer } from "node:buffer";
import { realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { failureMessage } from "../errors.ts";
import {
  filesClosed,
  markSandboxResumed,
  SandboxSaveOutlived,
  markSandboxSaved,
  resumesWithin,
} from "../sandbox.ts";
import type { ToolbeltInstall } from "../runtime/toolbelt.ts";
import type { HeldStop } from "./held-stop.ts";
import type { SandboxSave } from "../session/model.ts";
import type { SessionManager } from "../session/session-manager.ts";
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

export const SANDBOX_HOOK_MODES = [
  "save",
  "restore",
  "resume",
  "stop",
] as const;
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
   * Before the sandbox is saved, as the server is saved: put what sessions
   * committed on storage, so that falling back to their checkpoints loses
   * nothing, and say what the save catches.
   */
  save: () => Promise<SandboxSave>;
  /**
   * After the sandbox was restored from what it saved at `savedAtMs`: its
   * connections to the outside are gone, and it may serve another host.
   */
  restore: (savedAtMs: number) => Promise<void>;
  /**
   * The stop the server holds for a save, if it holds stops: a restore lets
   * it go, a resume goes on with it, and `stop` goes on with it at once, or
   * with the next, where none is held yet.
   */
  stop?: Pick<HeldStop, "restored" | "resumed" | "goOn">;
}

/**
 * What restoreSandboxServer is given of the server it restores: its sessions,
 * and its toolbelt's install.
 */
export interface RestoredServer {
  manager: Pick<SessionManager, "assertSandboxRestorable" | "sandboxRestored">;
  toolbelt?: Pick<ToolbeltInstall, "restored">;
}

/**
 * What a server does as its sandbox is restored from a save of `savedAtMs`:
 * it refuses the restore, by throwing, where the state directory has moved on
 * since the save, and then does nothing else of it, as the restore fails.
 * Otherwise it tells each live session's next exec how it came back, and
 * installs the toolbelt again where the save caught it installing, even when
 * telling the sessions fails.
 */
export function restoreSandboxServer(
  { manager, toolbelt }: RestoredServer,
  savedAtMs: number,
): void {
  manager.assertSandboxRestorable();
  try {
    manager.sandboxRestored(savedAtMs);
  } finally {
    toolbelt?.restored();
  }
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
  // Whether the server was restored from a save its state directory had moved
  // on from.
  let outlived = false;
  // Whether `stop` was asked while the server was saved, which waits for it
  // to run on: a server restored from the save leaves it as its old pod's.
  let stopAsked = false;
  // One mode at a time, in the order they came.
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const done = tail.then(work);
    tail = done.catch(() => undefined);
    return done;
  };
  const resume = () => {
    savedAtMs = undefined;
    markSandboxResumed();
  };
  // The server runs on after a save, which failed or left the sandbox
  // running: the stop held goes on, as one asked meanwhile does.
  const runOn = () => {
    resume();
    handlers.stop?.resumed();
    if (stopAsked) {
      stopAsked = false;
      handlers.stop?.goOn(
        "sandbox-hook stop asked it to as the server was saved",
      );
    }
  };
  // What each mode answers, past its "ok": a save, what it caught.
  const handle = async (mode: SandboxHookMode): Promise<string | undefined> => {
    switch (mode) {
      case "save": {
        markSandboxSaved();
        let caught: SandboxSave;
        try {
          caught = await inSpan("bayma.sandbox.save", {}, async () => {
            // No file is held open by work that would move on with it.
            await filesClosed();
            return handlers.save();
          });
        } catch (error) {
          runOn();
          throw error;
        }
        savedAtMs = Date.now();
        const save = ++saves;
        void resumesWithin(SAVE_EXPIRY_MS).then((resumed) => {
          if (resumed) return;
          void queue(async () => {
            // Saved again since, the server waits for that save's expiry;
            // restored from an outlived save, it waits for good.
            if (savedAtMs === undefined || saves !== save || outlived) return;
            report(
              `bayma: the server runs on, saved ${SAVE_EXPIRY_MS / 1000} s ago and neither restored nor resumed since`,
            );
            runOn();
          });
        });
        return JSON.stringify(caught);
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
        } catch (error) {
          // Restored from a save its state directory has moved on from, the
          // server stays saved, for good: running on, it would write over what
          // is newer, as the sandbox the save was taken of did since.
          if (error instanceof SandboxSaveOutlived) {
            outlived = true;
            report(
              `bayma: the server stays saved, as the save it was restored from is outlived: ${error.message}`,
            );
            throw error;
          }
          // Restored all the same: a stop held or asked as it was saved was
          // its old pod's.
          stopAsked = false;
          resume();
          handlers.stop?.restored();
          throw error;
        }
        stopAsked = false;
        resume();
        handlers.stop?.restored();
        return undefined;
      }
      case "resume":
        await inSpan("bayma.sandbox.resume", {}, async () => runOn());
        return undefined;
      case "stop":
        // Saved, the server waits to run on: going on with its stop now would
        // write over what the save caught.
        if (savedAtMs !== undefined) stopAsked = true;
        else handlers.stop?.goOn("sandbox-hook stop asked it to");
        return undefined;
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
        (answer) =>
          socket.end(answer === undefined ? "ok\n" : `ok ${answer}\n`),
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
 * for it to have done what that takes: what it answers, a save what it
 * caught, as JSON (SandboxSave), the others nothing. Throws what it could
 * not do.
 */
export async function runSandboxHook(
  stateDir: string,
  mode: SandboxHookMode,
): Promise<string | undefined> {
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
  if (answer === "ok\n") return undefined;
  if (answer.startsWith("ok ") && answer.endsWith("\n"))
    return answer.slice("ok ".length, -1);
  throw new Error(
    `the bayma server of ${stateDir} could not ${mode}: ${answer.trimEnd() || "it closed the connection"}`,
  );
}
