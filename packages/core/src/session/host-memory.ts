import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// What a session's host holds of its own, as the runtime memory budget counts
// it: the anonymous memory, and the swap, of every process of the host's
// process group, the host's children among them, as a Rust host's evaluator,
// `lake env`'s Lean and a cell's subprocesses are. Pages of files, as a Go
// plugin's text, are left out: the kernel takes them back as it needs. Where
// the kernel says each process's proportional share, the pages a fork left
// shared between a process and its child count once, not once for each.

/** The process group of the process whose /proc/<pid>/stat is `stat`. */
function processGroupOf(stat: string): number | undefined {
  // The command's name, in parentheses, may hold anything; the fields after it
  // are the state, the parent's pid, then the process group.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const group = Number(fields[2]);
  return Number.isSafeInteger(group) && group > 0 ? group : undefined;
}

/**
 * The kB of every "<name>: <kB> kB" line of `text` of each of `names`, summed,
 * as many as there are, as smaps has one of each for each mapping; undefined
 * where one of `names` has none.
 */
function kibOf(text: string, names: readonly string[]): number | undefined {
  let sum = 0;
  for (const name of names) {
    const lines = [
      ...text.matchAll(new RegExp(`^${name}:\\s+(\\d+) kB$`, "gm")),
    ];
    if (lines.length === 0) return undefined;
    for (const [, kib] of lines) sum += Number(kib);
  }
  return sum;
}

/** What the file `path` holds, or undefined where it cannot be read, as of a process that has ended. */
function readOrNothing(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * What the process `pid` holds of anonymous memory and swap, in bytes, from
 * the first of its files that says it: its smaps_rollup (Pss_Anon and SwapPss,
 * its proportional shares, where Linux says them, or else Anonymous and
 * Swap), its status (RssAnon, VmSwap), or its smaps (Anonymous and Swap, of
 * every mapping), which is all gVisor says it in; undefined where none does.
 */
function anonymousBytesOf(procRoot: string, pid: string): number | undefined {
  const read = (file: string, ...readings: (readonly string[])[]) => {
    const text = readOrNothing(join(procRoot, pid, file));
    if (text === undefined) return undefined;
    for (const names of readings) {
      const kib = kibOf(text, names);
      if (kib !== undefined) return kib;
    }
    return undefined;
  };
  const kib =
    read("smaps_rollup", ["Pss_Anon", "SwapPss"], ["Anonymous", "Swap"]) ??
    read("status", ["RssAnon", "VmSwap"]) ??
    read("smaps", ["Anonymous", "Swap"]);
  return kib === undefined ? undefined : kib * 1024;
}

/**
 * What the host `pid` holds of its own, as the module says, in bytes:
 * undefined where its process group, or what any process of it holds, cannot
 * be told. A process that ends as the group is read counts for nothing.
 */
export function hostAnonymousBytes(
  pid: number,
  procRoot = "/proc",
): number | undefined {
  const hostStat = readOrNothing(join(procRoot, String(pid), "stat"));
  const group = hostStat === undefined ? undefined : processGroupOf(hostStat);
  if (group === undefined) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch {
    return undefined;
  }
  let sum = 0;
  let counted = false;
  for (const entry of entries) {
    const stat = readOrNothing(join(procRoot, entry, "stat"));
    if (stat === undefined || processGroupOf(stat) !== group) continue;
    const bytes = anonymousBytesOf(procRoot, entry);
    // A member that has ended counts for nothing; one that runs and cannot be
    // told leaves the group's untold.
    if (bytes === undefined) {
      if (readOrNothing(join(procRoot, entry, "stat")) === undefined) continue;
      return undefined;
    }
    sum += bytes;
    counted = true;
  }
  return counted ? sum : undefined;
}
