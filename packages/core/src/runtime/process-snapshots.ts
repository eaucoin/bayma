import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { failureMessage } from "../errors.ts";
import { removeTree } from "../remove-tree.ts";
import { report } from "../telemetry/record.ts";
import { BAYMA_VERSION } from "../version.ts";

/**
 * Process snapshots: a session's runtime process tree dumped to disk whole
 * with CRIU, every variable, loaded library, open file, and thread of it, and
 * restored later, by this server or another one in a fresh container. They
 * are available where bayma's image puts CRIU and bayma's PID helper on PATH,
 * with the capabilities CRIU needs; elsewhere sessions outlive the server
 * through their checkpoints alone.
 */

/** What a restore needs to know about a dumped tree, beyond its images. */
export interface ProcessSnapshot {
  /** The tree's root, restored at the same PID. */
  pid: number;
  /** The highest PID or thread ID in the tree, which a restore needs free. */
  maxPid: number;
  /**
   * The stdin, stdout, and stderr the root started with, as the kernel names
   * them, such as `socket:[1234]`, wherever in the tree they are now: the
   * server's ends of them are outside it, so a restore hands in new ones in
   * their place.
   */
  stdio: [string, string, string];
  /**
   * Where the root held them when it was dumped: the restored root holds its
   * new stdio there.
   */
  stdioFds: [number, number, number];
  /** The boot it was taken in: after a reboot, clocks it relies on are gone. */
  bootId: string;
  /** The bayma that took it, whose payload the tree maps. */
  baymaVersion: string;
  createdAtMs: number;
}

export interface ProcessSnapshotter {
  /**
   * Dump the tree rooted at `pid`, which started with `stdio`, into
   * `directory`, which ends the tree.
   */
  dump(
    pid: number,
    directory: string,
    stdio: [string, string, string],
  ): ProcessSnapshot;
  /**
   * The command that restores `snapshot` from `directory` and then waits on
   * the restored tree, exiting as it does. Run with three new stdio streams,
   * which it hands to the tree in place of the ones it had.
   */
  restoreCommand(
    snapshot: ProcessSnapshot,
    directory: string,
  ): { file: string; args: string[] };
  /** The restored root's PID, once the restore that writes it has finished. */
  restoredPid(directory: string): number | undefined;
  /** Why `snapshot` cannot be restored here, or undefined if it can. */
  unrestorableReason(snapshot: ProcessSnapshot): string | undefined;
  /**
   * Whether this PID namespace's PID counter is past `pid`, with a PID left
   * before it wraps, or undefined where that cannot be read.
   */
  pidsPast(pid: number): boolean | undefined;
  /**
   * This PID namespace's PID counter: the last PID it handed out, and the
   * pid_max its PIDs end below, past which it wraps to its lowest free ones;
   * undefined where either cannot be read.
   */
  pidCounter(): PidCounter | undefined;
  /**
   * Move this PID namespace's PID counter past `pid`, never back, so no
   * process started from now on takes a PID at or below it until the counter
   * wraps; it starts nothing where the counter is past it already. With
   * `wrapping`, `pid` lies past the counter's wrap, behind it: the counter is
   * moved round past pid_max to it. Rejects where no PID the namespace hands
   * out lies past it.
   */
  advancePidsPast(pid: number, options?: { wrapping?: boolean }): Promise<void>;
}

/** A PID namespace's PID counter, as ProcessSnapshotter.pidCounter reads it. */
export interface PidCounter {
  /** The last PID it handed out. */
  last: number;
  /** The pid_max its PIDs end below. */
  max: number;
}

/**
 * How many PIDs a server's start moves its PID counter through at most for
 * the process snapshots it holds: some 8 s where it climbs them a process a
 * PID, at the 12,000 a second a machine forks, well within the time a server
 * is given to start.
 */
export const PID_ADVANCE_BUDGET = 100_000;

/** What a server's start does with its PID counter for the snapshots it holds (pidReservation). */
export interface PidReservation {
  /** The PID it moves the counter past, and whether round its wrap; none where no snapshot needs it. */
  advance: { past: number; wrapping: boolean } | undefined;
  /**
   * The snapshots it moves the counter past none of the PIDs of, as they lie
   * further ahead of it than PID_ADVANCE_BUDGET: how many, and how far the
   * nearest's last PID is, in PIDs the counter hands out before it.
   */
  beyond: { count: number; nearest: number } | undefined;
}

/**
 * What a server's start does with `counter` for the stored process snapshots
 * `snapshots`, which restore their trees at the PIDs they had, as a restore
 * places each with clone3's set_tid: of those the counter would hand out
 * PIDs of within `budget` PIDs, it is moved past the last's highest, round
 * its wrap where that lies behind it, so nothing started from now on takes a
 * PID one of them needs; the others are left, each to restore while its PIDs
 * stay free, as they do until the counter has climbed that far, and else, as
 * a restore that finds a PID taken does, from its checkpoint. Pure, for
 * tests.
 */
export function pidReservation(
  counter: PidCounter,
  snapshots: readonly Pick<ProcessSnapshot, "pid" | "maxPid">[],
  budget = PID_ADVANCE_BUDGET,
): PidReservation {
  let advance: { past: number; need: number } | undefined;
  let beyond: { count: number; nearest: number } | undefined;
  for (const { maxPid } of snapshots) {
    // The PIDs handed out before the counter is past the snapshot's highest.
    const need = pidsBefore(counter, maxPid) + 1;
    if (need <= budget) {
      if (!advance || need > advance.need) advance = { past: maxPid, need };
    } else {
      beyond = {
        count: (beyond?.count ?? 0) + 1,
        nearest: Math.min(beyond?.nearest ?? Infinity, need),
      };
    }
  }
  return {
    advance: advance && {
      past: advance.past,
      wrapping: advance.past <= counter.last,
    },
    beyond,
  };
}

/**
 * The lowest PID a namespace's counter hands out once it has wrapped, as
 * Linux's RESERVED_PIDS keeps those below it for the processes a system
 * starts first.
 */
export const LOWEST_WRAPPED_PID = 300;

/**
 * How many PIDs the counter `counter` hands out before it hands out `pid`:
 * those up to its pid_max first, and then, once it has wrapped, those from
 * LOWEST_WRAPPED_PID up; Infinity for a PID it never hands out again, at or
 * past its pid_max, or below LOWEST_WRAPPED_PID and behind it. Pure, for
 * tests.
 */
export function pidsBefore(counter: PidCounter, pid: number): number {
  if (pid >= counter.max) return Infinity;
  if (pid > counter.last) return pid - counter.last - 1;
  if (pid < LOWEST_WRAPPED_PID) return Infinity;
  return counter.max - counter.last - 1 + (pid - LOWEST_WRAPPED_PID);
}

/**
 * The PID every session's runtime starts above where its processes can be
 * snapshotted, so that each snapshot's tree, restored at the PIDs it had,
 * lies above everything the restoring server starts before it reserves them:
 * its own threads, V8's and libuv's, which no reservation can come before,
 * and what its container ran before it, a few dozen PIDs in a fresh one. Far
 * above those, and far below the 32768 a kernel's PID limit is at its lowest
 * by default (gVisor's is 65536), it leaves the counter more than 20,000 PIDs
 * to climb before it wraps. Where the limit is below it, it cannot be
 * reached, and that is reported.
 */
export const SESSION_PID_FLOOR = 10_000;

const CRIU = "criu";
const ADVANCE_PIDS = "bayma-advance-pids";
const DUMP_LOG = "dump.log";
const RESTORE_LOG = "restore.log";
const RESTORED_PID_FILE = "restored.pid";
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
// The last PID this PID namespace handed out, which anyone may read, and the
// one its PIDs end below.
const NS_LAST_PID = "/proc/sys/kernel/ns_last_pid";
const PID_MAX = "/proc/sys/kernel/pid_max";
const DUMP_TIMEOUT_MS = 120_000;

// CRIU's options for every dump and restore: CRIU runs with only the
// capabilities it is given, not as root; bayma's server holds a lock on its
// state directory; established TCP connections are dropped, since their peers
// give up on them anyway; and a file a process still maps after deleting it,
// as the Go host does with each cell's plugin, travels in the images.
const COMMON_OPTIONS = [
  "--unprivileged",
  "--file-locks",
  "--tcp-close",
  "--ext-unix-sk",
];
const GHOST_LIMIT = "1G";
// What bayma's container is run with for CRIU to run in it, as the README's
// command runs it.
const CONTAINER_OPTIONS =
  "--cap-add CHECKPOINT_RESTORE --cap-add SYS_PTRACE --security-opt seccomp=unconfined";
// How much of what CRIU printed a failure's message keeps, as of its log.
const FAILURE_LINES = 6;

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readBootId(): string {
  return readFileSync(BOOT_ID, "utf8").trim();
}

/** The number a /proc/sys file holds, or undefined where it cannot be read. */
function readCount(path: string): number | undefined {
  try {
    const count = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

/** Every process and thread ID in the tree rooted at `pid`. */
function treeIds(pid: number): number[] {
  const ids: number[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    const member = pending.pop()!;
    for (const task of readdirSync(`/proc/${member}/task`)) {
      ids.push(Number(task));
      const children = readFileSync(
        `/proc/${member}/task/${task}/children`,
        "utf8",
      );
      pending.push(...children.split(/\s+/).filter(Boolean).map(Number));
    }
  }
  return ids;
}

/** Where `pid` holds each of `files`, as the kernel names them. */
function heldAt(
  pid: number,
  files: readonly [string, string, string],
): [number, number, number] {
  const held = new Map<string, number>();
  for (const fd of readdirSync(`/proc/${pid}/fd`)
    .map(Number)
    .sort((a, b) => a - b)) {
    try {
      const file = readlinkSync(`/proc/${pid}/fd/${fd}`);
      if (!held.has(file)) held.set(file, fd);
    } catch {
      // Closed as it was read.
    }
  }
  return files.map((file) => {
    const fd = held.get(file);
    if (fd === undefined)
      throw new Error(`process ${pid} no longer holds its stdio ${file}`);
    return fd;
  }) as [number, number, number];
}

/** How a run of CRIU ended, as `spawnSync` reports it. */
export interface CriuExit {
  /** Why it did not run to its end: it could not start, or ran out of time. */
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * How a run of CRIU that failed ended, and, where the environment kept it
 * from running, what changes that.
 */
export function criuEnding({ error, status, signal }: CriuExit): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // Only dumps run with a timeout.
  if (code === "ETIMEDOUT")
    return `CRIU did not finish within ${DUMP_TIMEOUT_MS} ms`;
  // CRIU's binary holds the capabilities it runs with, and the kernel refuses
  // to execute it for a process whose bounding set lacks any of them.
  if (code === "EPERM")
    return `CRIU could not start (${error!.message}): the capabilities it runs with are not all in this process's bounding set; run bayma's container with ${CONTAINER_OPTIONS}`;
  if (error) return `CRIU could not start: ${error.message}`;
  if (signal) return `CRIU was killed by ${signal}`;
  return `CRIU exited with status ${status}`;
}

/** The last lines of `text`, for a failure's message. */
function lastLines(text: string): string {
  return text.trim().split("\n").slice(-FAILURE_LINES).join("\n");
}

/** CRIU's errors from `log`, or undefined if it wrote none. */
function criuErrors(directory: string, log: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(directory, log), "utf8");
  } catch {
    return undefined;
  }
  const errors = text.split("\n").filter((line) => line.includes("Error"));
  return errors.length > 0 ? lastLines(errors.join("\n")) : lastLines(text);
}

/**
 * Why a run of CRIU failed, for a failure's message: how it `ended`, what it
 * printed, where it reports what fails before its log is open, and the errors
 * in its log.
 */
function criuFailure(
  ended: string,
  output: string,
  directory: string,
  log: string,
): string {
  return [ended, lastLines(output), criuErrors(directory, log)]
    .filter(Boolean)
    .join("\n");
}

/** The external-socket option for each of `stdio` that is a Unix socket. */
function externalSockets(stdio: readonly string[]): string[] {
  return stdio.flatMap((link) => {
    const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
    return inode ? ["--external", `unix[${inode}]`] : [];
  });
}

export class CriuSnapshotter implements ProcessSnapshotter {
  private readonly criu: string;
  private readonly advancePids: string;

  constructor(criu: string, advancePids: string) {
    this.criu = criu;
    this.advancePids = advancePids;
  }

  dump(
    pid: number,
    directory: string,
    stdio: [string, string, string],
  ): ProcessSnapshot {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const maxPid = Math.max(...treeIds(pid));
    const stdioFds = heldAt(pid, stdio);
    const result = spawnSync(
      this.criu,
      [
        "dump",
        "--tree",
        String(pid),
        "--images-dir",
        directory,
        "--log-file",
        DUMP_LOG,
        "--ghost-limit",
        GHOST_LIMIT,
        ...externalSockets(stdio),
        ...COMMON_OPTIONS,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        timeout: DUMP_TIMEOUT_MS,
      },
    );
    if (result.status !== 0) {
      const failure = criuFailure(
        criuEnding(result),
        // There is no output when CRIU could not start.
        result.stderr ?? "",
        directory,
        DUMP_LOG,
      );
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`process snapshot of ${pid} failed:\n${failure}`);
    }
    return {
      pid,
      maxPid,
      stdio,
      stdioFds,
      bootId: readBootId(),
      baymaVersion: BAYMA_VERSION,
      createdAtMs: Date.now(),
    };
  }

  restoreCommand(
    snapshot: ProcessSnapshot,
    directory: string,
  ): { file: string; args: string[] } {
    // The PID file appears only once this restore has finished.
    rmSync(join(directory, RESTORED_PID_FILE), { force: true });
    return {
      file: this.criu,
      args: [
        "restore",
        "--images-dir",
        directory,
        "--log-file",
        RESTORE_LOG,
        "--pidfile",
        join(directory, RESTORED_PID_FILE),
        ...snapshot.stdio.flatMap((link, fd) => [
          "--inherit-fd",
          `fd[${fd}]:${link}`,
        ]),
        ...COMMON_OPTIONS,
      ],
    };
  }

  restoredPid(directory: string): number | undefined {
    try {
      const pid = Number(
        readFileSync(join(directory, RESTORED_PID_FILE), "utf8").trim(),
      );
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  unrestorableReason(snapshot: ProcessSnapshot): string | undefined {
    if (snapshot.baymaVersion !== BAYMA_VERSION)
      return `it was taken by bayma ${snapshot.baymaVersion}, and this is ${BAYMA_VERSION}`;
    if (snapshot.bootId !== readBootId())
      return "the machine has restarted since it was taken";
    return undefined;
  }

  pidsPast(pid: number): boolean | undefined {
    const counter = this.pidCounter();
    if (!counter) return undefined;
    return counter.last >= pid && counter.last < counter.max - 1;
  }

  pidCounter(): PidCounter | undefined {
    const last = readCount(NS_LAST_PID);
    const max = readCount(PID_MAX);
    return last === undefined || max === undefined ? undefined : { last, max };
  }

  async advancePidsPast(
    pid: number,
    { wrapping = false }: { wrapping?: boolean } = {},
  ): Promise<void> {
    if (!wrapping && this.pidsPast(pid)) return;
    // Past the namespace's last PID is its end, from which the counter wraps:
    // the helper takes that last PID, as none past it can be taken.
    const max = readCount(PID_MAX);
    const target = max !== undefined && pid === max - 1 ? pid : pid + 1;
    // Off the event loop: climbing to a PID ahead, where the counter cannot
    // be set, takes the helper a process a PID.
    let stderr = "";
    let status: number | null;
    try {
      const args = [...(wrapping ? ["--wrap"] : []), String(target)];
      const helper = spawn(this.advancePids, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      helper.stderr.setEncoding("utf8");
      helper.stderr.on("data", (text: string) => (stderr += text));
      [status] = await once(helper, "close");
    } catch (error) {
      throw new Error(
        `advancing PIDs past ${pid} failed: ${failureMessage(error)}`,
      );
    }
    if (status !== 0) {
      throw new Error(
        `advancing PIDs past ${pid} failed: ${stderr.trim() || `status ${status}`}`,
      );
    }
  }
}

/**
 * Whether a restore's `failure`, as restoreFailure says it, is that a PID its
 * tree needs was taken, by a process started since it was dumped: CRIU places
 * each at its PID with clone3's set_tid, which the kernel refuses with EEXIST
 * where it is in use, as CRIU logs it, "Can't fork for 27: File exists".
 * Pure, for tests.
 */
export function restoreLostPids(failure: string): boolean {
  return /Can't fork for \d+: File exists/.test(failure);
}

/**
 * Why a restore from `directory` ended without a restored tree: how it
 * `ended`, what CRIU printed, its `output`, and the errors in its log.
 */
export function restoreFailure(
  directory: string,
  ended: string,
  output: string,
): string {
  return criuFailure(ended, output, directory, RESTORE_LOG);
}

function detectSnapshotter(env: NodeJS.ProcessEnv): ProcessSnapshotter | null {
  const criu = onPath(CRIU, env);
  const advancePids = onPath(ADVANCE_PIDS, env);
  return process.platform === "linux" && criu && advancePids
    ? new CriuSnapshotter(criu, advancePids)
    : null;
}

// This process's own environment is searched once.
let detected: ProcessSnapshotter | null | undefined;

/**
 * The snapshotter of this environment: CRIU and bayma's PID helper, where
 * bayma's image puts them on PATH, or null where there are none.
 */
export function processSnapshotter(
  env: NodeJS.ProcessEnv = process.env,
): ProcessSnapshotter | null {
  if (env !== process.env) return detectSnapshotter(env);
  if (detected === undefined) detected = detectSnapshotter(env);
  return detected;
}

const availability = new WeakMap<
  ProcessSnapshotter,
  Promise<string | undefined>
>();

/**
 * Why `snapshotter` cannot snapshot sessions here, or undefined if it can, as
 * `snapshotsUnavailableReason` finds it the first time it is asked. Where
 * CRIU cannot run, as in a container without its capabilities or a gVisor
 * sandbox, a server then dumps no session only to fail.
 */
export function snapshotsUnavailableHere(
  snapshotter: ProcessSnapshotter,
): Promise<string | undefined> {
  let found = availability.get(snapshotter);
  if (!found) {
    found = snapshotsUnavailableReason(snapshotter);
    availability.set(snapshotter, found);
  }
  return found;
}

/**
 * Why `snapshotter` cannot snapshot sessions here, or undefined if it can:
 * found by dumping a process started for it, as a session's tree is dumped
 * when the server stops.
 */
export async function snapshotsUnavailableReason(
  snapshotter: ProcessSnapshotter | null,
): Promise<string | undefined> {
  if (!snapshotter)
    return `${CRIU} and ${ADVANCE_PIDS} are not both on PATH, as bayma's image puts them`;
  const directory = mkdtempSync(join(tmpdir(), "bayma-snapshots-"));
  // Leading a session of its own, as a session's runtime does.
  const tree = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  try {
    await once(tree, "spawn");
    const stdio = [0, 1, 2].map((fd) =>
      readlinkSync(`/proc/${tree.pid}/fd/${fd}`),
    ) as [string, string, string];
    snapshotter.dump(tree.pid!, join(directory, "images"), stdio);
    return undefined;
  } catch (error) {
    return failureMessage(error);
  } finally {
    // A dump ends the tree; a failed one leaves it.
    tree.kill("SIGKILL");
    // A cleanup, whose failure changes nothing of what the probe found.
    const failure = removeTree(directory);
    if (failure)
      report(
        `bayma: could not remove ${directory}, where it tried a process snapshot: ${failureMessage(failure)}`,
      );
  }
}
