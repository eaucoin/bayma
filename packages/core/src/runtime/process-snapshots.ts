import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { delimiter, join } from "node:path";
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
   * Move this PID namespace's PID counter past `pid`, so no process started
   * from now on takes a PID a stored snapshot needs.
   */
  advancePidsPast(pid: number): void;
}

const CRIU = "criu";
const ADVANCE_PIDS = "bayma-advance-pids";
const DUMP_LOG = "dump.log";
const RESTORE_LOG = "restore.log";
const RESTORED_PID_FILE = "restored.pid";
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
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

/** CRIU's errors from `log`, for a failure's message. */
function criuErrors(directory: string, log: string): string {
  let lines: string[];
  try {
    lines = readFileSync(join(directory, log), "utf8").split("\n");
  } catch {
    return "CRIU wrote no log";
  }
  const errors = lines.filter((line) => line.includes("Error"));
  return (errors.length > 0 ? errors : lines).slice(-6).join("\n");
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
      { stdio: "ignore", timeout: DUMP_TIMEOUT_MS },
    );
    if (result.status !== 0) {
      const failure = criuErrors(directory, DUMP_LOG);
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

  advancePidsPast(pid: number): void {
    const result = spawnSync(this.advancePids, [String(pid + 1)], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `advancing PIDs past ${pid} failed: ${result.stderr.trim() || `status ${result.status}`}`,
      );
    }
  }
}

/** Why a restore that ended without a restored tree failed, from its log. */
export function restoreFailure(directory: string): string {
  return criuErrors(directory, RESTORE_LOG);
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
