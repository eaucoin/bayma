import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { parseCliOptions } from "../cli-options.ts";
import { failureMessage } from "../errors.ts";

// How a host that saves the whole sandbox bayma runs in, and restores it,
// perhaps elsewhere and much later, as gVisor's runsc does, tells the server
// so: it runs `bayma sandbox-hook` in the sandbox before the save and after
// the restore (`runsc checkpoint --save-restore-exec-argv`, whose mode the
// command reads from GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE), which passes the
// mode on to the server over a Unix socket in the server's state directory.
// It needs no network, which the restored sandbox may not have yet, and no
// token, which the restore may be about to replace; the state directory's
// mode keeps it to the server's own user. A host whose save leaves the
// sandbox running gives the hook --leave-running, as it gives runsc, which
// runs the hook with the save's arguments at the restore or resume that
// follows it too: a save that ends the sandbox first collects the server's
// garbage, which one left running must not. A host that knows why it stopped
// the sandbox it restores, as one stopped as it ran out of its memory, says
// so in BAYMA_SANDBOX_STOP_REASON, which the restore passes on with its mode,
// for each live session's next exec to be told.
//
// This module is the hook's side of it, and what the server shares of it: the
// hook starts as a process of its own on the path of every save and restore,
// so the server's entry (packages/server/src/main.ts) runs it with this module
// alone loaded, none of the server's.

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
 * Where a host names why it stopped the sandbox it restores, as the end of
 * a sentence: "it ran out of its memory (4Gi)".
 */
export const SANDBOX_STOP_REASON_VARIABLE = "BAYMA_SANDBOX_STOP_REASON";

/** The longest reason a restore passes on, in bytes. */
export const MAX_STOP_REASON_BYTES = 256;

/** What a host gives the hook of a save that leaves the sandbox running. */
export const LEAVE_RUNNING_OPTION = "--leave-running";

// What a save that leaves the sandbox running tells the server past its mode.
const LEAVES_RUNNING = "leave-running";

/**
 * What the hook asks the server: its mode, with a save's whether the sandbox
 * runs on after it, and a restore's why its host stopped the sandbox, where
 * it says.
 */
export type SandboxHookRequest =
  | { mode: "save"; leavesRunning: boolean }
  | { mode: "restore"; stopReason?: string }
  | { mode: "resume" | "stop" };

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
 * A request to the server, as the hook sends it, but for its newline: the
 * mode, and after a space, what the mode is told, where it is told anything.
 */
export function formatSandboxHookRequest(request: SandboxHookRequest): string {
  switch (request.mode) {
    case "save":
      return request.leavesRunning ? `save ${LEAVES_RUNNING}` : "save";
    case "restore":
      return request.stopReason === undefined
        ? "restore"
        : `restore ${request.stopReason}`;
    default:
      return request.mode;
  }
}

/**
 * The request a line to the server names (formatSandboxHookRequest), a
 * restore's reason the sandbox stopped as parseSandboxStopReason takes it.
 */
export function parseSandboxHookRequest(line: string): SandboxHookRequest {
  const space = line.indexOf(" ");
  const mode = parseSandboxHookMode(space === -1 ? line : line.slice(0, space));
  const told = space === -1 ? undefined : line.slice(space + 1);
  switch (mode) {
    case "save":
      if (told !== undefined && told !== LEAVES_RUNNING)
        throw new Error(
          `a save is told nothing past its mode but ${LEAVES_RUNNING}`,
        );
      return { mode, leavesRunning: told !== undefined };
    case "restore":
      return { mode, stopReason: parseSandboxStopReason(told) };
    default:
      if (told !== undefined)
        throw new Error(`a ${mode} is told nothing past its mode`);
      return { mode };
  }
}

/**
 * The reason a host gave why it stopped the sandbox, as the hook sends it
 * and the server takes it: none where it gave none, or an empty one, and
 * refused where it is not one line of at most MAX_STOP_REASON_BYTES, the
 * refusal naming where it was given, `from`, where it says.
 */
export function parseSandboxStopReason(
  value: string | undefined,
  from?: string,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  const of = from === undefined ? "" : ` (${from})`;
  if (/[\r\n]/u.test(value))
    throw new Error(`the reason the sandbox stopped must be one line${of}`);
  if (Buffer.byteLength(value) > MAX_STOP_REASON_BYTES)
    throw new Error(
      `the reason the sandbox stopped must be at most ${MAX_STOP_REASON_BYTES} bytes${of}`,
    );
  return value;
}

/**
 * Tells the server of `stateDir` that its sandbox is at `mode`, a save with
 * whether it leaves the sandbox running (`leavesRunning`), a restore with why
 * its host stopped the sandbox where it says (`stopReason`), which no other
 * mode is told, and waits for it to have done what that takes: what it
 * answers, a save what it caught, as JSON (SandboxSave), the others nothing.
 * Throws what it could not do.
 */
export async function runSandboxHook(
  stateDir: string,
  mode: SandboxHookMode,
  {
    leavesRunning = false,
    stopReason,
  }: { leavesRunning?: boolean; stopReason?: string } = {},
): Promise<string | undefined> {
  const request = `${formatSandboxHookRequest(
    mode === "save"
      ? { mode, leavesRunning }
      : mode === "restore"
        ? {
            mode,
            stopReason: parseSandboxStopReason(
              stopReason,
              SANDBOX_STOP_REASON_VARIABLE,
            ),
          }
        : { mode },
  )}\n`;
  // The server's state directory is where its lease resolved it to.
  const path = sandboxHookSocket(realpathSync(resolve(stateDir)));
  const answer = await new Promise<string>((resolveAnswer, rejectAnswer) => {
    let received = "";
    const socket = net.connect(path, () => socket.write(request));
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

/**
 * `bayma sandbox-hook [MODE] --state-dir PATH [--leave-running]`, given its
 * arguments after the command's name: tells the server of the state
 * directory that its sandbox is at the mode, which gVisor names in the
 * environment unless the command names one first, a save that it leaves the
 * sandbox running where told so, and prints what the server answers, if
 * anything.
 */
export async function runSandboxHookCommand(args: string[]): Promise<void> {
  const options = args.filter((arg) => arg !== LEAVE_RUNNING_OPTION);
  if (args.length - options.length > 1)
    throw new Error(`option ${LEAVE_RUNNING_OPTION} may be provided only once`);
  const named = options.length % 2 === 1 ? options[0] : undefined;
  const parsed = parseCliOptions(
    named === undefined ? options : options.slice(1),
    ["--state-dir"],
  );
  // A host runs the hook from a directory of its own, such as the sandbox's
  // root, not the server's: the state directory is named.
  const stateDir = parsed.get("--state-dir");
  if (stateDir === undefined)
    throw new Error("sandbox-hook needs --state-dir, its server's");
  // The server records what the hook sets off; this process only asks it to,
  // so it exports no telemetry of its own.
  const mode = parseSandboxHookMode(
    named ?? process.env[SANDBOX_HOOK_MODE_VARIABLE],
  );
  const caught = await runSandboxHook(stateDir, mode, {
    leavesRunning: options.length < args.length,
    stopReason: process.env[SANDBOX_STOP_REASON_VARIABLE],
  });
  if (caught !== undefined) console.log(caught);
}
