import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostAnonymousBytes } from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

/** A process in the /proc at `root`: its stat, of process group `group`, and what it says of its memory. */
function processIn(
  root: string,
  pid: number,
  group: number,
  memory: { rollup?: string; status?: string; smaps?: string },
  comm = "host",
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "stat"),
    `${pid} (${comm}) S 1 ${group} ${group} 0 -1 4194560 0 0 0 0\n`,
  );
  if (memory.rollup !== undefined)
    writeFileSync(join(dir, "smaps_rollup"), memory.rollup);
  if (memory.status !== undefined)
    writeFileSync(join(dir, "status"), memory.status);
  if (memory.smaps !== undefined)
    writeFileSync(join(dir, "smaps"), memory.smaps);
}

const rollup = (anonymousKib: number, swapKib = 0, fileKib = 0) =>
  [
    `Rss:            ${anonymousKib + fileKib} kB`,
    `Anonymous:      ${anonymousKib} kB`,
    `Swap:           ${swapKib} kB`,
    "",
  ].join("\n");

test("a host holds the anonymous memory and swap of every process of its group, its children among them, and none of its files' pages", async () => {
  await withTempDir(async (root) => {
    // The host, its group's leader, holding a plugin's text besides.
    processIn(root, 100, 100, { rollup: rollup(1_000, 0, 50_000) });
    // Its evaluator child, as a Rust host's, with some swapped.
    processIn(root, 101, 100, { rollup: rollup(2_000, 500) }, "evcxr child) S");
    // A process of another group, not the host's.
    processIn(root, 200, 200, { rollup: rollup(9_000) });
    expect(hostAnonymousBytes(100, root)).toBe((1_000 + 2_000 + 500) * 1024);
    // The child's own group is its leader's.
    expect(hostAnonymousBytes(101, root)).toBe((1_000 + 2_000 + 500) * 1024);
  });
});

test("a process without smaps_rollup is read from its status, one that ends as the group is read counts for nothing, and one untold leaves the host untold", async () => {
  await withTempDir(async (root) => {
    processIn(root, 100, 100, {
      status: "Name:\thost\nRssAnon:\t    3000 kB\nVmSwap:\t       0 kB\n",
    });
    expect(hostAnonymousBytes(100, root)).toBe(3_000 * 1024);
    // One that has ended leaves its directory without a stat.
    mkdirSync(join(root, "102"));
    expect(hostAnonymousBytes(100, root)).toBe(3_000 * 1024);
    // One that runs and says nothing of its memory.
    processIn(root, 103, 100, {});
    expect(hostAnonymousBytes(100, root)).toBeUndefined();
    // A host that is gone.
    expect(hostAnonymousBytes(999, root)).toBeUndefined();
  });
});

/** A mapping of smaps as gVisor's Sentry writes one, its Pss its Rss, its Swap none. */
const gvisorMapping = (range: string, rssKib: number, anonymousKib: number) =>
  [
    `${range} rw-p 00000000 00:00 0 `,
    `Size:           ${rssKib} kB`,
    `Rss:            ${rssKib} kB`,
    `Pss:            ${rssKib} kB`,
    `Anonymous:      ${anonymousKib} kB`,
    "Swap:                  0 kB",
    "SwapPss:               0 kB",
    "VmFlags: rd wr mr mw me ac ",
    "",
  ].join("\n");

test("a host in gVisor, whose /proc has no smaps_rollup and a status of no RssAnon or VmSwap, is read from its smaps, every mapping's anonymous memory summed", async () => {
  await withTempDir(async (root) => {
    const status =
      "Name:\thost\nVmSize:\t 9000000 kB\nVmRSS:\t   70000 kB\nVmData:\t  500000 kB\n";
    processIn(root, 100, 100, {
      status,
      smaps: [
        // Its heap, and a mapping of a file it holds the pages of.
        gvisorMapping("00400000-08400000", 60_000, 60_000),
        gvisorMapping("7f0000000000-7f0000a00000", 10_000, 0),
        // A thread's stack.
        gvisorMapping("7ffd00000000-7ffd00200000", 2_000, 2_000),
      ].join(""),
    });
    processIn(root, 101, 100, {
      status,
      smaps: gvisorMapping("00400000-00800000", 4_000, 3_000),
    });
    expect(hostAnonymousBytes(100, root)).toBe((60_000 + 2_000 + 3_000) * 1024);
  });
});

test("where Linux says a process's proportional share of its anonymous memory and swap, the pages a fork left shared count once", async () => {
  await withTempDir(async (root) => {
    // A parent and the child it forked share 8000 kB, half of them each.
    const forked = (ownKib: number) =>
      [
        `Anonymous:      ${ownKib + 8_000} kB`,
        `Pss_Anon:       ${ownKib + 4_000} kB`,
        "Swap:              200 kB",
        "SwapPss:           100 kB",
        "",
      ].join("\n");
    processIn(root, 100, 100, { rollup: forked(1_000) });
    processIn(root, 101, 100, { rollup: forked(2_000) });
    expect(hostAnonymousBytes(100, root)).toBe(
      (1_000 + 2_000 + 8_000 + 200) * 1024,
    );
  });
});
