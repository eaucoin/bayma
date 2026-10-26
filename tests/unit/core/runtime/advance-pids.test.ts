import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// bayma's PID helper (packages/core/native/advance-pids.c), built as the image
// builds it, on kernel settings of a test's own where it sets the counter, and
// on this namespace's where it climbs it.

const SOURCE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "core",
  "native",
  "advance-pids.c",
);
let helper: string;
// What the tests made, removed as they end.
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "bayma-advance-pids-"));
  made.push(dir);
  helper = join(dir, "bayma-advance-pids");
  const built = Bun.spawnSync([
    "cc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    helper,
    SOURCE,
  ]);
  expect(built.stderr.toString()).toBe("");
  expect(built.exitCode).toBe(0);
});

/** Kernel settings of a test's own: its pid_max and ns_last_pid, the latter writable or not. */
function kernel(
  lastPid: number,
  { writable = true, pidMax = 4_194_304 } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "bayma-kernel-"));
  made.push(dir);
  writeFileSync(join(dir, "pid_max"), `${pidMax}\n`);
  writeFileSync(join(dir, "ns_last_pid"), `${lastPid}\n`);
  if (!writable) chmodSync(join(dir, "ns_last_pid"), 0o444);
  return dir;
}

function advance(
  args: string[],
  kernelDir?: string,
): { status: number; stderr: string } {
  const ran = Bun.spawnSync([helper, ...args], {
    env: {
      ...process.env,
      ...(kernelDir ? { BAYMA_ADVANCE_PIDS_KERNEL: kernelDir } : {}),
    },
  });
  return { status: ran.exitCode, stderr: ran.stderr.toString() };
}

const lastOf = (dir: string) =>
  Number(readFileSync(join(dir, "ns_last_pid"), "utf8"));

test("where ns_last_pid may be written, the counter is set just below the target at once, however far ahead", () => {
  const dir = kernel(10_000);
  expect(advance(["3000000"], dir)).toEqual({ status: 0, stderr: "" });
  expect(lastOf(dir)).toBe(2_999_999);
});

test("a counter past the target is left as it is, unless the target lies past its wrap, which it is set round to", () => {
  const past = kernel(50_000);
  expect(advance(["12000"], past)).toEqual({ status: 0, stderr: "" });
  expect(lastOf(past)).toBe(50_000);
  const nearMax = kernel(4_194_000);
  expect(advance(["--wrap", "12000"], nearMax)).toEqual({
    status: 0,
    stderr: "",
  });
  expect(lastOf(nearMax)).toBe(11_999);
});

// As root, a read-only file is written all the same.
test.skipIf(process.getuid?.() === 0)(
  "where ns_last_pid cannot be written, the counter is climbed a process a PID, this namespace's own",
  () => {
    const real = () =>
      Number(readFileSync("/proc/sys/kernel/ns_last_pid", "utf8"));
    const target = real() + 200;
    // Settings of the test's own, read-only, but for its pid_max this namespace's.
    const dir = kernel(real(), {
      writable: false,
      pidMax: Number(readFileSync("/proc/sys/kernel/pid_max", "utf8")),
    });
    expect(advance([String(target)], dir)).toEqual({ status: 0, stderr: "" });
    expect(real()).toBeGreaterThanOrEqual(target);
  },
);

test.skipIf(process.getuid?.() === 0)(
  "round its wrap, a counter that cannot be set is climbed to the target once it has wrapped, as its first PID may at once, or as it had since the target was found behind it",
  () => {
    const real = () =>
      Number(readFileSync("/proc/sys/kernel/ns_last_pid", "utf8"));
    const pidMax = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8"));
    // Its last PID read as its end's, so the first climbed, this namespace's, lies below it: wrapped at once.
    const atEnd = kernel(pidMax - 2, { writable: false, pidMax });
    const first = real() + 200;
    expect(advance(["--wrap", String(first)], atEnd)).toEqual({
      status: 0,
      stderr: "",
    });
    expect(real()).toBeGreaterThanOrEqual(first);
    // Its last PID below the target already, as after a wrap since it was found behind it: climbed straight to it.
    const second = real() + 200;
    const wrapped = kernel(real(), { writable: false, pidMax });
    expect(advance(["--wrap", String(second)], wrapped)).toEqual({
      status: 0,
      stderr: "",
    });
    const reached = real();
    expect(reached).toBeGreaterThanOrEqual(second);
    expect(reached).toBeLessThan(second + 1_000);
  },
);

test("a target at or past pid_max is refused, and so are arguments that name none", () => {
  const dir = kernel(10_000, { pidMax: 32_768 });
  expect(advance(["32768"], dir)).toEqual({
    status: 1,
    stderr:
      "bayma-advance-pids: PID 32768 is not below this namespace's pid_max, 32768\n",
  });
  for (const args of [[], ["--wrap"], ["x"], ["--round", "5"], ["0"]]) {
    expect(advance(args, dir)).toEqual({
      status: 2,
      stderr: "usage: bayma-advance-pids [--wrap] <target PID>\n",
    });
  }
});
