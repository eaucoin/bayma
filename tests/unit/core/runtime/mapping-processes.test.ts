import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { killIfStill } from "@bayma/core";

// The fresh start's kill of what maps a session's scratch
// (packages/core/src/runtime/mapping-processes.ts): a process found is killed
// only while its pid is still its own.

/** The start time `/proc` says the process `pid` has: its stat's 22nd field. */
function startTimeOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(" ")[22 - 3]!;
}

test("a process found is killed only while its pid has the start time it was found with", async () => {
  const found = Bun.spawn([
    process.execPath,
    "-e",
    "setInterval(() => {}, 1000)",
  ]);
  try {
    const startTime = startTimeOf(found.pid);
    // As a process given the pid after the one found would be: left alone.
    expect(
      await killIfStill({
        pid: found.pid,
        startTime: String(BigInt(startTime) + 1n),
        cmdline: "",
      }),
    ).toBe(false);
    await Bun.sleep(50);
    expect(found.exitCode).toBeNull();
    expect(found.signalCode).toBeNull();
    // The one found: killed.
    expect(await killIfStill({ pid: found.pid, startTime, cmdline: "" })).toBe(
      true,
    );
    await found.exited;
    expect(found.signalCode).toBe("SIGKILL");
  } finally {
    found.kill();
  }
});
