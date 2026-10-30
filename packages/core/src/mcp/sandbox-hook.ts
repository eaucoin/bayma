import { Buffer } from "node:buffer";
import { rmSync } from "node:fs";
import net from "node:net";
import { failureMessage } from "../errors.ts";
import { removeTree } from "../remove-tree.ts";
import {
  filesClosed,
  markSandboxResumed,
  SandboxSaveOutlived,
  markSandboxSaved,
  resumesWithin,
  runningTimeout,
} from "../sandbox.ts";
import type { HeldStop } from "./held-stop.ts";
import type { SandboxSave } from "../session/model.ts";
import type { SessionManager } from "../session/session-manager.ts";
import { inSpan, report } from "../telemetry/record.ts";
import {
  MAX_STOP_REASON_BYTES,
  parseSandboxHookRequest,
  sandboxHookSocket,
  type SandboxHookMode,
} from "./sandbox-hook-client.ts";

// The server's side of the sandbox hook (./sandbox-hook-client.ts).

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
  restore: (savedAtMs: number, stopReason?: string) => Promise<void>;
  /**
   * The stop the server holds for a save, if it holds stops: a restore lets
   * it go, a resume goes on with it, and `stop` goes on with it at once, or
   * with the next, where none is held yet.
   */
  stop?: Pick<HeldStop, "restored" | "resumed" | "goOn">;
}

/**
 * What a server does as its sandbox is restored from a save of `savedAtMs`:
 * it refuses the restore, by throwing, where the state directory has moved on
 * since the save, and then does nothing else of it, as the restore fails.
 * Otherwise it tells each live session's next exec how it came back, and why
 * the sandbox stopped where its host said (`stopReason`).
 */
export function restoreSandboxServer(
  manager: Pick<SessionManager, "assertSandboxRestorable" | "sandboxRestored">,
  savedAtMs: number,
  stopReason?: string,
): void {
  manager.assertSandboxRestorable();
  manager.sandboxRestored(savedAtMs, stopReason);
}

// A Unix socket's path is at most this many bytes long.
const MAX_SOCKET_PATH_BYTES = 107;
// The longest request the hook sends: its mode, a restore's reason the
// sandbox stopped after a space, and a newline.
const MAX_REQUEST_BYTES = 16 + MAX_STOP_REASON_BYTES;
// The hook sends its request as soon as it connects: a connection that has
// sent none within this long is closed.
const REQUEST_TIMEOUT_MS = 5_000;
// A save that no restore or resume follows within this much of the time the
// server runs, as when its host's checkpoint failed and it ran no resume, is
// given up on: no save takes this long.
const SAVE_EXPIRY_MS = 10 * 60_000;

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
  const handle = async (
    mode: SandboxHookMode,
    stopReason: string | undefined,
  ): Promise<string | undefined> => {
    if (stopReason !== undefined && mode !== "restore")
      throw new Error(`a ${mode} is told no reason the sandbox stopped`);
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
            () => handlers.restore(restoredFrom, stopReason),
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
    // A connection that sends nothing in time is closed, once the server has
    // read what came by then (runningTimeout): a restored server stops
    // running while its pages come in, and the hook's request may come
    // meanwhile.
    const sendsNothing = runningTimeout(
      () => socket.destroy(),
      REQUEST_TIMEOUT_MS,
    );
    socket.on("close", () => sendsNothing.clear());
    socket.on("data", (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      const end = request.indexOf("\n");
      if ((end === -1 ? request.length : end + 1) > MAX_REQUEST_BYTES) {
        socket.removeAllListeners("data");
        sendsNothing.clear();
        socket.end("the sandbox hook's request is too long\n");
        return;
      }
      if (end === -1) return;
      socket.removeAllListeners("data");
      // What the mode takes may take longer than a request may.
      sendsNothing.clear();
      queue(() =>
        handle(...parseSandboxHookRequest(request.subarray(0, end).toString())),
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
        // A cleanup, which says what it could not do and never stops the close.
        const failure = removeTree(path);
        if (failure)
          report(
            `bayma: could not remove the sandbox hook's socket ${path}: ${failureMessage(failure)}`,
          );
        resolveClose();
      });
    });
}
