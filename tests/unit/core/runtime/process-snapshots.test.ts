import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BAYMA_VERSION,
  CriuSnapshotter,
  processSnapshotter,
  restoreFailure,
  type ProcessSnapshot,
} from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

const BOOT_ID = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

const snapshot: ProcessSnapshot = {
  pid: 4_100,
  maxPid: 4_142,
  stdio: ["socket:[11]", "pipe:[12]", "pipe:[13]"],
  stdioFds: [0, 1, 2],
  bootId: BOOT_ID,
  baymaVersion: BAYMA_VERSION,
  createdAtMs: 1,
};

/** An executable shell script at `path`. */
function writeScript(path: string, body: string): string {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A stand-in for CRIU that records its arguments in `dir`, one per line,
 * writes `log` into the images directory it is given, as CRIU writes its
 * log, and exits with `status`.
 */
function fakeCriu(dir: string, log: string, status: number): string {
  return writeScript(
    join(dir, "criu"),
    [
      `printf '%s\\n' "$@" > ${JSON.stringify(join(dir, "criu-args"))}`,
      'while [ "$#" -gt 0 ]; do',
      '  if [ "$1" = --images-dir ]; then images="$2"; fi',
      "  shift",
      "done",
      `printf '%s\\n' ${JSON.stringify(log)} > "$images/dump.log"`,
      `exit ${status}`,
    ].join("\n"),
  );
}

test("there is no snapshotter without CRIU and bayma's PID helper on PATH", async () => {
  await withTempDir((dir) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);

    expect(processSnapshotter({ PATH: bin })).toBeNull();
    writeScript(join(bin, "criu"), "exit 0");
    expect(processSnapshotter({ PATH: bin })).toBeNull();
    writeScript(join(bin, "bayma-advance-pids"), "exit 0");
    expect(processSnapshotter({ PATH: bin })).toBeInstanceOf(CriuSnapshotter);
  });
});

test("a restore hands the tree new stdio in place of the ones it was dumped with", async () => {
  await withTempDir((dir) => {
    const pidFile = join(dir, "restored.pid");
    writeFileSync(pidFile, "4100\n");
    const snapshotter = new CriuSnapshotter("/opt/criu", "/opt/advance-pids");

    expect(snapshotter.restoreCommand(snapshot, dir)).toEqual({
      file: "/opt/criu",
      args: [
        "restore",
        "--images-dir",
        dir,
        "--log-file",
        "restore.log",
        "--pidfile",
        pidFile,
        "--inherit-fd",
        "fd[0]:socket:[11]",
        "--inherit-fd",
        "fd[1]:pipe:[12]",
        "--inherit-fd",
        "fd[2]:pipe:[13]",
        "--unprivileged",
        "--file-locks",
        "--tcp-close",
        "--ext-unix-sk",
      ],
    });
    // An earlier restore's PID file cannot pass for this one's.
    expect(existsSync(pidFile)).toBe(false);
  });
});

test("the restored PID is known once the restore writes it", async () => {
  await withTempDir((dir) => {
    const snapshotter = new CriuSnapshotter("/opt/criu", "/opt/advance-pids");
    const pidFile = join(dir, "restored.pid");

    expect(snapshotter.restoredPid(dir)).toBeUndefined();
    writeFileSync(pidFile, "");
    expect(snapshotter.restoredPid(dir)).toBeUndefined();
    writeFileSync(pidFile, "4100\n");
    expect(snapshotter.restoredPid(dir)).toBe(4_100);
  });
});

test("a snapshot from another bayma or another boot cannot be restored", () => {
  const snapshotter = new CriuSnapshotter("/opt/criu", "/opt/advance-pids");

  expect(snapshotter.unrestorableReason(snapshot)).toBeUndefined();
  expect(
    snapshotter.unrestorableReason({ ...snapshot, baymaVersion: "0.0.1" }),
  ).toBe(`it was taken by bayma 0.0.1, and this is ${BAYMA_VERSION}`);
  expect(
    snapshotter.unrestorableReason({ ...snapshot, bootId: "another-boot" }),
  ).toBe("the machine has restarted since it was taken");
});

test("a failed restore is explained by CRIU's errors", async () => {
  await withTempDir((dir) => {
    expect(restoreFailure(dir)).toBe("CRIU wrote no log");

    writeFileSync(
      join(dir, "restore.log"),
      [
        "(00.000001) Version: 4.1",
        "(00.000200) Error (criu/cr-restore.c:1): PID 4100 is taken",
        "(00.000300) Restoring FAILED.",
      ].join("\n"),
    );
    expect(restoreFailure(dir)).toBe(
      "(00.000200) Error (criu/cr-restore.c:1): PID 4100 is taken",
    );
  });
});

test("a dump records what its restore needs, and a failed one leaves no images", async () => {
  await withTempDir(async (dir) => {
    const images = join(dir, "images");
    const tree = Bun.spawn(["sleep", "30"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdio = [0, 1, 2].map((fd) =>
      readlinkSync(`/proc/${tree.pid}/fd/${fd}`),
    ) as [string, string, string];
    try {
      const dumped = new CriuSnapshotter(
        fakeCriu(dir, "(00.1) Dumping finished successfully", 0),
        "/opt/advance-pids",
      ).dump(tree.pid, images, stdio);

      expect(dumped).toEqual({
        pid: tree.pid,
        maxPid: tree.pid,
        stdio,
        stdioFds: [0, 1, 2],
        bootId: BOOT_ID,
        baymaVersion: BAYMA_VERSION,
        createdAtMs: expect.any(Number),
      });
      expect(existsSync(join(images, "dump.log"))).toBe(true);
      // The server's ends of the tree's stdio sockets are outside the tree.
      const externals = dumped.stdio.flatMap((link) => {
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
        return inode ? ["--external", `unix[${inode}]`] : [];
      });
      expect(
        readFileSync(join(dir, "criu-args"), "utf8").trimEnd().split("\n"),
      ).toEqual([
        "dump",
        "--tree",
        String(tree.pid),
        "--images-dir",
        images,
        "--log-file",
        "dump.log",
        "--ghost-limit",
        "1G",
        ...externals,
        "--unprivileged",
        "--file-locks",
        "--tcp-close",
        "--ext-unix-sk",
      ]);

      expect(() =>
        new CriuSnapshotter(
          fakeCriu(dir, "(00.1) Error (criu/cr-dump.c:1): simulated", 1),
          "/opt/advance-pids",
        ).dump(tree.pid, images, stdio),
      ).toThrow(
        `process snapshot of ${tree.pid} failed:\n(00.1) Error (criu/cr-dump.c:1): simulated`,
      );
      expect(existsSync(images)).toBe(false);
    } finally {
      tree.kill("SIGKILL");
      await tree.exited;
    }
  });
});

test("PIDs are advanced past the highest a snapshot needs, and a helper failure says why", async () => {
  await withTempDir((dir) => {
    const recorded = join(dir, "advanced");
    new CriuSnapshotter(
      "/opt/criu",
      writeScript(join(dir, "advance"), `printf '%s' "$1" > ${recorded}`),
    ).advancePidsPast(4_142);
    expect(readFileSync(recorded, "utf8")).toBe("4143");

    expect(() =>
      new CriuSnapshotter(
        "/opt/criu",
        writeScript(
          join(dir, "refuse"),
          "echo 'ns_last_pid: permission denied' >&2; exit 3",
        ),
      ).advancePidsPast(4_142),
    ).toThrow(
      "advancing PIDs past 4142 failed: ns_last_pid: permission denied",
    );
  });
});
