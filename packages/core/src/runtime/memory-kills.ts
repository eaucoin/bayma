import { readFileSync } from "node:fs";
import { join } from "node:path";

// Whether the kernel killed a runtime for its memory, as the cgroup the
// server runs in (v2) counts its kills (memory.events, oom_kill), and the
// limit it ran out of (memory.max): what tells a runtime killed so from one
// killed otherwise, as a kernel that kills the largest process of a cgroup
// out of its memory alone, as a Kubernetes node told singleProcessOOMKill
// does, kills a runtime and leaves the server running. Its kills are counted
// as a runtime starts and again as it dies of SIGKILL, one the server did not
// send it itself, so no kill before it started is taken for its own; of one
// CRIU restored, which CRIU runs and exits 0 as the kernel kills it, as it
// dies at all. The count is the whole cgroup's, every runtime's and every
// process's a cell starts, so it cannot tell a runtime the kernel killed from
// one something else killed with SIGKILL after another process of the cgroup
// ran out of its memory, nor a restored runtime that exits of itself, as a
// cell's sys.exit ends it, just after one: rare, and taken for the runtime's
// own. Where the cgroup's files cannot be read, as under cgroup v1, nothing
// is said of memory.

// Which process the kernel kills: the one of the cgroup holding the most
// memory, weighed by its oom_score_adj, from -1000, never, to 1000, first. The
// server has every process it starts that holds memory for others, a session's
// runtime and CRIU restoring one, raise its own to 1000 (killedFirstForMemory),
// so that the kernel kills any of them before the server, however little they
// hold. Raising it needs no privilege; lowering it below what the container
// started with does (CAP_SYS_RESOURCE), so the server leaves its own as it
// found it. That leaves one window: Linux 7.0's memory cgroup OOM killer no
// longer sees a process it killed once that process is exiting (a72f73c4dd9b,
// which hides exiting processes from what walks a cgroup's), so for the tens of
// milliseconds the kernel takes to free a killed runtime's memory, any process
// of the cgroup that asks for more is answered by another kill, of the next it
// sees, which is the server where nothing it started runs. Only a server the
// kernel never kills closes it: a launcher privileged to do so starts the
// server at -1000 (docker run --oom-score-adj -1000), and what the server
// starts raises its own from there.

/** The oom_score_adj of a process the kernel kills first for memory. */
export const KILLED_FIRST_FOR_MEMORY = 1000;

/**
 * What a shell runs to raise its own adjustment to KILLED_FIRST_FOR_MEMORY,
 * which the process it then execs keeps. The process raises its own, as only
 * it may once it runs a binary with file capabilities, as CRIU's, whose /proc
 * files are root's from then on; where the kernel refuses, it runs on as it
 * was.
 */
export const KILL_FIRST_FOR_MEMORY = `{ echo ${KILLED_FIRST_FOR_MEMORY} > /proc/self/oom_score_adj; } 2>/dev/null`;

/**
 * `file` run with `args` by a shell that has the kernel kill it before the
 * server as the cgroup runs out of memory, and what it starts, which inherits
 * its adjustment.
 */
export function killedFirstForMemory(
  file: string,
  args: readonly string[],
): { file: string; args: string[] } {
  return {
    file: "/bin/sh",
    args: ["-c", `${KILL_FIRST_FOR_MEMORY}; exec "$0" "$@"`, file, ...args],
  };
}

/** Where a process's cgroup is, as it sees it in a container of its own. */
export const CGROUP_DIR = "/sys/fs/cgroup";

/** A kill for memory: the limit the cgroup ran out of, or null for none. */
export interface MemoryKill {
  limit: string | null;
}

/**
 * What a runtime is told, as it dies, of whether it was killed for its
 * memory: the kill, or null where it was not, or the cgroup says nothing.
 */
export type MemoryKills = () => MemoryKill | null;

/** The kills for memory the cgroup at `dir` counts now: null if unreadable. */
function killsIn(dir: string): number | null {
  try {
    const line = readFileSync(join(dir, "memory.events"), "utf8")
      .split("\n")
      .find((each) => each.startsWith("oom_kill "));
    const kills = Number(line?.slice("oom_kill ".length));
    return line === undefined || !Number.isSafeInteger(kills) ? null : kills;
  } catch {
    return null;
  }
}

/** `bytes` as Kubernetes would write it: in whole GiB or MiB where it is. */
export function asQuantity(bytes: number): string {
  if (bytes % 2 ** 30 === 0) return `${bytes / 2 ** 30}Gi`;
  if (bytes % 2 ** 20 === 0) return `${bytes / 2 ** 20}Mi`;
  return String(bytes);
}

/** The memory limit of the cgroup at `dir`: null for none, or unreadable. */
function limitIn(dir: string): string | null {
  try {
    const max = readFileSync(join(dir, "memory.max"), "utf8").trim();
    return /^[0-9]+$/u.test(max) ? asQuantity(Number(max)) : null;
  } catch {
    return null;
  }
}

/**
 * Counts the kills for memory of the cgroup at `dir` now, as a runtime
 * starts: what tells, as it dies, whether one since was its own.
 */
export function watchMemoryKills(dir: string = CGROUP_DIR): MemoryKills {
  const before = killsIn(dir);
  return () => {
    if (before === null) return null;
    const now = killsIn(dir);
    return now !== null && now > before ? { limit: limitIn(dir) } : null;
  };
}

/** What a runtime killed for its memory did, as a sentence's end. */
export function ranOutOf({ limit }: MemoryKill): string {
  return limit === null
    ? "ran out of memory"
    : `ran out of its memory (${limit})`;
}

/**
 * How a runtime ended that the kernel killed for its memory, as its
 * transport tells it, which its session comes back from rather than being
 * quarantined.
 */
export class RuntimeMemoryKilled extends Error {
  readonly kill: MemoryKill;

  constructor(message: string, kill: MemoryKill) {
    super(message);
    this.name = "RuntimeMemoryKilled";
    this.kill = kill;
  }
}
