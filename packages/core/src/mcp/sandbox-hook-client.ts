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
// mode keeps it to the server's own user. A host that knows why it stopped
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
 * The mode a request to the server names, and the reason the sandbox stopped
 * it names after a space, where it names one (parseSandboxStopReason).
 */
export function parseSandboxHookRequest(
  request: string,
): [SandboxHookMode, string | undefined] {
  const space = request.indexOf(" ");
  if (space === -1) return [parseSandboxHookMode(request), undefined];
  return [
    parseSandboxHookMode(request.slice(0, space)),
    parseSandboxStopReason(request.slice(space + 1)),
  ];
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
 * Tells the server of `stateDir` that its sandbox is at `mode`, a restore
 * with why its host stopped the sandbox where it says (`stopReason`), and
 * waits for it to have done what that takes: what it answers, a save what it
 * caught, as JSON (SandboxSave), the others nothing. Throws what it could
 * not do.
 */
export async function runSandboxHook(
  stateDir: string,
  mode: SandboxHookMode,
  stopReason?: string,
): Promise<string | undefined> {
  const reason = parseSandboxStopReason(
    stopReason,
    SANDBOX_STOP_REASON_VARIABLE,
  );
  const request = reason === undefined ? `${mode}\n` : `${mode} ${reason}\n`;
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
 * `bayma sandbox-hook [MODE] --state-dir PATH`, given its arguments after the
 * command's name: tells the server of the state directory that its sandbox is
 * at the mode, which gVisor names in the environment unless the command names
 * one first, and prints what the server answers, if anything.
 */
export async function runSandboxHookCommand(args: string[]): Promise<void> {
  const named = args.length % 2 === 1 ? args[0] : undefined;
  const parsed = parseCliOptions(named === undefined ? args : args.slice(1), [
    "--state-dir",
  ]);
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
  const caught = await runSandboxHook(
    stateDir,
    mode,
    mode === "restore" ? process.env[SANDBOX_STOP_REASON_VARIABLE] : undefined,
  );
  if (caught !== undefined) console.log(caught);
}
