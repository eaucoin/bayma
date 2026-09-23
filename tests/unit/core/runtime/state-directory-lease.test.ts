import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { acquireStateDirectoryLease, createEngine } from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { withTempDir } from "../../../support/temp.ts";

test("a state directory has exactly one live owner", async () => {
  await withTempDir(async (root) => {
    const stateDir = `${root}/state`;
    mkdirSync(stateDir, { mode: 0o755 });
    if (process.platform !== "win32") chmodSync(stateDir, 0o755);
    const first = await acquireStateDirectoryLease(stateDir);
    expect(first.stateDir).toBeTruthy();
    expect(existsSync(first.lockPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(first.stateDir).mode & 0o777).toBe(0o700);
    }

    await expect(acquireStateDirectoryLease(stateDir)).rejects.toThrow(
      `Bayma state directory is already in use: ${first.stateDir}`,
    );

    await first.release();
    await first.release();
    expect(existsSync(first.lockPath)).toBe(true);

    const reacquired = await acquireStateDirectoryLease(stateDir);
    await reacquired.release();
  });
});

test("concurrent state-directory acquisition has exactly one winner", async () => {
  await withTempDir(async (root) => {
    const outcomes = await Promise.allSettled([
      acquireStateDirectoryLease(`${root}/state`),
      acquireStateDirectoryLease(`${root}/state`),
    ]);
    const acquired = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    await acquired[0]!.release();
  });
});

test("runtime wiring holds its state lease through shutdown", async () => {
  await withTempDir(async (root) => {
    const config = {
      stateDir: `${root}/state`,
      maxSessions: 8,
      warnUsagePercent: 75,
      defaultCols: 80,
      defaultRows: 24,
    };
    const first = await createEngine([bunAdapter], config, () => undefined);
    await expect(
      createEngine([bunAdapter], config, () => undefined),
    ).rejects.toThrow("Bayma state directory is already in use");

    await first.shutdown();
    const restarted = await createEngine([bunAdapter], config, () => undefined);
    await restarted.shutdown();
  });
});

test("initialization cleanup stops transport before releasing state", async () => {
  await withTempDir(async (root) => {
    const stateDir = `${root}/state`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${stateDir}/sessions`, "blocks catalog construction\n");
    let signalShutdownStarted!: () => void;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    let allowShutdown!: () => void;
    const shutdownAllowed = new Promise<void>((resolve) => {
      allowShutdown = resolve;
    });
    const transport = bunAdapter.createTransport();
    const creation = createEngine(
      [
        {
          adapter: bunAdapter,
          transport: {
            ...transport,
            shutdown: async () => {
              signalShutdownStarted();
              await shutdownAllowed;
              await transport.shutdown();
            },
          },
        },
      ],
      {
        stateDir,
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );

    await shutdownStarted;
    await expect(acquireStateDirectoryLease(stateDir)).rejects.toThrow(
      "Bayma state directory is already in use",
    );
    allowShutdown();
    await expect(creation).rejects.toThrow();
    const recovered = await acquireStateDirectoryLease(stateDir);
    await recovered.release();
  });
});

test("an ungraceful owner exit releases its operating-system lock", async () => {
  await withTempDir(async (root) => {
    const stateDir = `${root}/state`;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { acquireStateDirectoryLease } from "@bayma/core"; await acquireStateDirectoryLease(${JSON.stringify(stateDir)}); console.log("ready"); await new Promise(() => {});`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = child.stdout.getReader();
      const firstOutput = await reader.read();
      expect(new TextDecoder().decode(firstOutput.value)).toContain("ready");
    } finally {
      child.kill(9);
      await child.exited;
    }

    const recovered = await acquireStateDirectoryLease(stateDir);
    await recovered.release();
  });
});
