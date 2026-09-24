import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * One scratch directory per server process, under `root`, for the hosts it
 * starts. Leftovers from hosts that did not exit gracefully are swept the next
 * time a server starts: any sibling whose owning process is gone is removed.
 */
export function claimScratchDirectory(root: string): string {
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || processIsAlive(pid))
      continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
  const own = join(root, String(process.pid));
  mkdirSync(own, { recursive: true });
  return own;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
