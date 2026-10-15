import { readdir, readFile } from "node:fs/promises";
import { sep } from "node:path";

/**
 * A process, as /proc says it: its pid, its start time (its stat's 22nd
 * field, in clock ticks after boot), which tells it from a process given its
 * pid later, and its command line, its arguments joined by spaces.
 */
export interface MappingProcess {
  pid: number;
  startTime: string;
  cmdline: string;
}

/** A process's start time, as its stat `text` says, or null for none. */
function startTimeOf(text: string): string | null {
  // Its name, the second field, is in parentheses and may hold anything: the
  // fields after it begin past the last ")", from the third.
  const field = text
    .slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ")[22 - 3];
  return field !== undefined && /^[0-9]+$/.test(field) ? field : null;
}

/** The start time of the process `pid` now, or null for one that is gone. */
async function startTimeAt(pid: number): Promise<string | null> {
  try {
    return startTimeOf(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The processes of this process's user, other than this one, that map a file
 * under one of the directories `roots`, as each one's /proc/<pid>/maps says:
 * none where /proc cannot be read.
 */
export async function processesMapping(
  roots: readonly string[],
): Promise<MappingProcess[]> {
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((name) => /^[0-9]+$/.test(name));
  } catch {
    return [];
  }
  const unders = roots.map((root) => (root.endsWith(sep) ? root : root + sep));
  const uid = process.getuid?.();
  const found: MappingProcess[] = [];
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let status: string;
    let maps: string;
    let cmdline: string;
    let startTime: string | null;
    try {
      // The start time first: a process given the pid after it has another.
      startTime = await startTimeAt(Number(pid));
      status = await readFile(`/proc/${pid}/status`, "utf8");
      maps = await readFile(`/proc/${pid}/maps`, "utf8");
      cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (startTime === null) continue;
    // Its real user, the first of the Uid line's.
    const owner = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    if (uid !== undefined && Number(owner) !== uid) continue;
    // Each line ends in the mapped file's path, after five fields.
    if (
      maps
        .split("\n")
        .some((line) => unders.some((under) => line.includes(` ${under}`)))
    )
      found.push({
        pid: Number(pid),
        startTime,
        cmdline: cmdline.split("\0").filter(Boolean).join(" "),
      });
  }
  return found;
}

/**
 * Kills `found` (SIGKILL) if its pid is still its own, of the start time it
 * was found with, read again just before: whether it did.
 */
export async function killIfStill(found: MappingProcess): Promise<boolean> {
  if ((await startTimeAt(found.pid)) !== found.startTime) return false;
  try {
    process.kill(found.pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

/**
 * The hidepid option /proc is mounted with, as the mount table `mounts` (as
 * /proc/mounts reads) says, or null where it hides no process: with it, a
 * process sees none of other users' but its own.
 */
export function procHidepid(mounts: string): string | null {
  for (const line of mounts.split("\n")) {
    const [, target, type, options = ""] = line.split(" ");
    if (target !== "/proc" || type !== "proc") continue;
    const hidepid = options
      .split(",")
      .find((option) => option.startsWith("hidepid="))
      ?.slice("hidepid=".length);
    return hidepid === undefined || hidepid === "0" || hidepid === "off"
      ? null
      : hidepid;
  }
  return null;
}
