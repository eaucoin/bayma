import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  bindToolbelt,
  installToolbelt,
  PAYLOAD_MANIFEST,
  startToolbeltInstall,
  TOOLBELT_DIR,
  TOOLBELT_INSTALL_LOCK,
  TOOLBELT_VERSION_FILE,
  toolbeltPath,
} from "@bayma/core";
import { holdToolbeltInstallLock } from "../../../support/payload.ts";
import { withTempDir } from "../../../support/temp.ts";

/** A payload of `version` that carries a toolbelt holding one package. */
function writePayload(root: string, version: string): string {
  const payload = join(root, "payloads", version);
  const toolbelt = join(payload, TOOLBELT_DIR);
  mkdirSync(join(toolbelt, "node_modules", "package"), { recursive: true });
  writeFileSync(
    join(toolbelt, "node_modules", "package", "index.js"),
    `export const version = ${JSON.stringify(version)};\n`,
  );
  writeFileSync(join(payload, PAYLOAD_MANIFEST), JSON.stringify({ version }));
  return payload;
}

/**
 * Give a payload's toolbelt a Python environment as a payload build leaves
 * it: its interpreter link relative to the payload, and its `home` naming
 * where it was built.
 */
function writeVenv(payload: string): void {
  const bin = join(payload, TOOLBELT_DIR, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(
    join("..", "..", "..", "python", "bin", "python3"),
    join(bin, "python"),
  );
  writeFileSync(
    join(payload, TOOLBELT_DIR, ".venv", "pyvenv.cfg"),
    "home = /build/.work/python/python/bin\nrelocatable = true\n",
  );
}

function installedVersion(env: { XDG_DATA_HOME: string }): string {
  return readFileSync(join(toolbeltPath(env), TOOLBELT_VERSION_FILE), "utf8");
}

test("the toolbelt path lives under bayma's data root", () => {
  expect(toolbeltPath({ HOME: "/home/someone" })).toBe(
    "/home/someone/.local/share/bayma/toolbelt",
  );
  expect(toolbeltPath({ XDG_DATA_HOME: "/xdg/data" })).toBe(
    "/xdg/data/bayma/toolbelt",
  );
});

test("installing copies the payload's toolbelt to the toolbelt path, with its version", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    const reports: string[] = [];

    expect(
      await installToolbelt(payload, env, (message) => reports.push(message)),
    ).toBe(true);

    const installed = toolbeltPath(env);
    expect(lstatSync(installed).isDirectory()).toBe(true);
    expect(
      readFileSync(
        join(installed, "node_modules", "package", "index.js"),
        "utf8",
      ),
    ).toBe('export const version = "0.3.0";\n');
    expect(installedVersion(env)).toBe("0.3.0\n");
    expect(reports).toEqual([
      `bayma: installing the 0.3.0 toolbelt at ${installed}`,
      `bayma: installed the 0.3.0 toolbelt at ${installed}`,
    ]);
    // Nothing of the install is left beside the toolbelt but its lock.
    expect(readdirSync(dirname(installed)).sort()).toEqual([
      TOOLBELT_INSTALL_LOCK,
      TOOLBELT_DIR,
    ]);
  });
});

test("the copy keeps each file's mode, each directory's, and each link as it reads", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    const bin = join(payload, TOOLBELT_DIR, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tool"), "#!/bin/sh\n");
    chmodSync(join(bin, "tool"), 0o755);
    writeFileSync(join(bin, "data"), "");
    chmodSync(join(bin, "data"), 0o444);
    symlinkSync(join("..", "node_modules", "package"), join(bin, "package"));
    chmodSync(bin, 0o555);
    try {
      await installToolbelt(payload, env);
    } finally {
      chmodSync(bin, 0o755);
    }

    const copied = join(toolbeltPath(env), "bin");
    const mode = (path: string) => lstatSync(path).mode & 0o777;
    expect(mode(join(copied, "tool"))).toBe(0o755);
    expect(mode(join(copied, "data"))).toBe(0o444);
    expect(mode(copied)).toBe(0o555);
    expect(readlinkSync(join(copied, "package"))).toBe(
      join("..", "node_modules", "package"),
    );
    chmodSync(copied, 0o755);
  });
});

test("a toolbelt already installed from the same version is left as it is", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    await installToolbelt(payload, env);
    const marker = join(toolbeltPath(env), "left-by-an-earlier-install");
    writeFileSync(marker, "");
    const reports: string[] = [];

    expect(
      await installToolbelt(payload, env, (message) => reports.push(message)),
    ).toBe(false);

    expect(existsSync(marker)).toBe(true);
    expect(reports).toEqual([]);
  });
});

test("another version's toolbelt is replaced whole", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    await installToolbelt(writePayload(root, "0.10.0"), env);
    const stale = join(toolbeltPath(env), "only-in-0.10.0");
    writeFileSync(stale, "");

    // Whichever version starts, its own toolbelt is what the skills load.
    await installToolbelt(writePayload(root, "0.3.0"), env);

    expect(installedVersion(env)).toBe("0.3.0\n");
    expect(existsSync(stale)).toBe(false);
    expect(
      readFileSync(
        join(toolbeltPath(env), "node_modules", "package", "index.js"),
        "utf8",
      ),
    ).toBe('export const version = "0.3.0";\n');
    expect(readdirSync(dirname(toolbeltPath(env))).sort()).toEqual([
      TOOLBELT_INSTALL_LOCK,
      TOOLBELT_DIR,
    ]);
  });
});

test("the link an earlier bayma made at the toolbelt path is replaced by a copy", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const earlier = writePayload(root, "0.2.0");
    mkdirSync(dirname(toolbeltPath(env)), { recursive: true });
    symlinkSync(join(earlier, TOOLBELT_DIR), toolbeltPath(env));

    await installToolbelt(writePayload(root, "0.3.0"), env);

    expect(lstatSync(toolbeltPath(env)).isDirectory()).toBe(true);
    expect(installedVersion(env)).toBe("0.3.0\n");
    // The payload the link named is not touched.
    expect(existsSync(join(earlier, TOOLBELT_DIR, "node_modules"))).toBe(true);
  });
});

test("the installed toolbelt's Python environment runs the payload's interpreter", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    writeVenv(payload);

    await installToolbelt(payload, env);

    const venv = join(toolbeltPath(env), ".venv");
    const interpreter = join(payload, "python", "bin", "python3");
    expect(readlinkSync(join(venv, "bin", "python"))).toBe(interpreter);
    expect(readFileSync(join(venv, "pyvenv.cfg"), "utf8")).toBe(
      `home = ${dirname(interpreter)}\nrelocatable = true\n`,
    );
    // The payload's own environment stays relative to the payload.
    expect(
      readlinkSync(join(payload, TOOLBELT_DIR, ".venv", "bin", "python")),
    ).toBe(join("..", "..", "..", "python", "bin", "python3"));
  });
});

test("a payload without a toolbelt installs nothing", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = join(root, "payloads", "0.2.3");
    mkdirSync(payload, { recursive: true });

    await installToolbelt(payload, env);

    expect(existsSync(toolbeltPath(env))).toBe(false);
  });
});

test("a payload whose manifest names no version is refused", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    writeFileSync(join(payload, PAYLOAD_MANIFEST), JSON.stringify({}));

    await expect(installToolbelt(payload, env)).rejects.toThrow(
      `${PAYLOAD_MANIFEST} names no version: ${payload}`,
    );
    expect(existsSync(toolbeltPath(env))).toBe(false);
  });
});

test("binding points the toolbelt's environment at the payload's interpreter where the payload will run", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const staged = writePayload(root, "0.3.1");
    writeVenv(staged);
    const installed = join(root, "payloads", "installed");

    bindToolbelt(staged, installed);

    expect(
      readFileSync(join(staged, TOOLBELT_DIR, ".venv", "pyvenv.cfg"), "utf8"),
    ).toBe(`home = ${join(installed, "python", "bin")}\nrelocatable = true\n`);
  });
});

test("binding a payload without a toolbelt environment changes nothing", async () => {
  await withTempDir((dir) => {
    const payload = writePayload(realpathSync(dir), "0.3.1");

    expect(() => bindToolbelt(payload)).not.toThrow();
  });
});

/** `count` empty files in a new directory, `directory`. */
function writeFiles(directory: string, count: number): void {
  mkdirSync(directory);
  for (let index = 0; index < count; index += 1)
    writeFileSync(join(directory, String(index)), "");
}

/** Resolves once `reports` holds a report starting with `start`. */
async function reported(reports: string[], start: string): Promise<void> {
  while (!reports.some((report) => report.startsWith(start))) await sleep(10);
}

test("what an interrupted install left beside the toolbelt is removed, even where the toolbelt is current", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    await installToolbelt(payload, env);
    const parent = dirname(toolbeltPath(env));
    for (const left of ["toolbelt.Ab12Cd", "toolbelt.Ef34Gh.replaced"])
      mkdirSync(join(parent, left, "node_modules"), { recursive: true });
    // Only what an install leaves is an install's to remove.
    mkdirSync(join(parent, "toolbelt.notes"));
    const reports: string[] = [];

    expect(
      await installToolbelt(payload, env, (message) => reports.push(message)),
    ).toBe(false);

    expect(readdirSync(parent).sort()).toEqual([
      TOOLBELT_INSTALL_LOCK,
      TOOLBELT_DIR,
      "toolbelt.notes",
    ]);
    expect(reports.sort()).toEqual([
      `bayma: removed ${join(parent, "toolbelt.Ab12Cd")}, which an interrupted install left`,
      `bayma: removed ${join(parent, "toolbelt.Ef34Gh.replaced")}, which an interrupted install left`,
    ]);
  });
});

test("a current toolbelt is used as it is where no one may write beside it", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    await installToolbelt(payload, env);
    const parent = dirname(toolbeltPath(env));
    rmSync(join(parent, TOOLBELT_INSTALL_LOCK));
    chmodSync(parent, 0o555);
    try {
      expect(await installToolbelt(payload, env)).toBe(false);
      expect(readdirSync(parent)).toEqual([TOOLBELT_DIR]);
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

test("an install waits for another bayma installing, and leaves what that one assembles alone", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const release = holdToolbeltInstallLock(env);
    // What the other bayma is assembling.
    const assembling = join(dirname(toolbeltPath(env)), "toolbelt.Live01");
    mkdirSync(assembling);
    const reports: string[] = [];

    const installing = installToolbelt(
      writePayload(root, "0.3.0"),
      env,
      (message) => reports.push(message),
    );
    await reported(reports, "bayma: waiting for another bayma");
    expect(existsSync(assembling)).toBe(true);
    expect(existsSync(toolbeltPath(env))).toBe(false);

    // It died before finishing: what it assembled is left for whoever next
    // holds the lock.
    release();
    expect(await installing).toBe(true);
    expect(installedVersion(env)).toBe("0.3.0\n");
    expect(existsSync(assembling)).toBe(false);
    expect(reports).toEqual([
      `bayma: waiting for another bayma to finish installing the toolbelt at ${toolbeltPath(env)}`,
      `bayma: removed ${assembling}, which an interrupted install left`,
      `bayma: installing the 0.3.0 toolbelt at ${toolbeltPath(env)}`,
      `bayma: installed the 0.3.0 toolbelt at ${toolbeltPath(env)}`,
    ]);
  });
});

test("installs of one toolbelt at once copy it once", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");

    const installed = await Promise.all([
      installToolbelt(payload, env),
      installToolbelt(payload, env),
    ]);

    expect(installed.sort()).toEqual([false, true]);
    expect(installedVersion(env)).toBe("0.3.0\n");
  });
});

test("a stopped install leaves nothing of itself, and the toolbelt it would have replaced", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    await installToolbelt(writePayload(root, "0.2.0"), env);
    const stopping = new AbortController();

    // Stopped with its copy under way, at its first report of progress.
    const payload = writePayload(root, "0.3.0");
    writeFiles(join(payload, TOOLBELT_DIR, "bulk"), 6_000);
    await expect(
      installToolbelt(
        payload,
        env,
        (message) => {
          if (message.startsWith("bayma: copied")) stopping.abort();
        },
        stopping.signal,
      ),
    ).rejects.toThrow("aborted");

    expect(installedVersion(env)).toBe("0.2.0\n");
    expect(readdirSync(dirname(toolbeltPath(env))).sort()).toEqual([
      TOOLBELT_INSTALL_LOCK,
      TOOLBELT_DIR,
    ]);

    // Stopped waiting for another bayma.
    const release = holdToolbeltInstallLock(env);
    const waiting = new AbortController();
    const reports: string[] = [];
    const installing = installToolbelt(
      writePayload(root, "0.4.0"),
      env,
      (message) => reports.push(message),
      waiting.signal,
    );
    await reported(reports, "bayma: waiting for another bayma");
    waiting.abort();
    await expect(installing).rejects.toThrow("aborted");
    release();
    expect(installedVersion(env)).toBe("0.2.0\n");
  });
});

test("an install reports its progress as it copies", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    // With node_modules, its package, the package's file, and their
    // directory, 5,000 files and directories.
    writeFiles(join(payload, TOOLBELT_DIR, "bulk"), 4_996);
    const reports: string[] = [];

    await installToolbelt(payload, env, (message) => reports.push(message));

    expect(reports).toEqual([
      `bayma: installing the 0.3.0 toolbelt at ${toolbeltPath(env)}`,
      "bayma: copied 5000 of the toolbelt's files and directories",
      `bayma: installed the 0.3.0 toolbelt at ${toolbeltPath(env)}`,
    ]);
  });
});

test("an install in the background reports how it ended, and stops when told", async () => {
  await withTempDir(async (dir) => {
    const root = realpathSync(dir);
    const payload = writePayload(root, "0.3.0");
    const reports: string[] = [];
    const report = (message: string) => reports.push(message);

    const env = { XDG_DATA_HOME: join(root, "data") };
    const release = holdToolbeltInstallLock(env);
    const install = startToolbeltInstall(payload, env, report);
    await reported(reports, "bayma: waiting for another bayma");
    await install.stop();
    release();
    expect(reports.at(-1)).toBe(
      "bayma: stopped installing the toolbelt, which the next start installs",
    );
    expect(existsSync(toolbeltPath(env))).toBe(false);

    // Where the data root cannot be made, the install fails, and says so.
    writeFileSync(join(root, "file"), "");
    const failing = startToolbeltInstall(
      payload,
      { XDG_DATA_HOME: join(root, "file") },
      report,
    );
    await reported(reports, "bayma: installing the toolbelt failed: ");
    await failing.stop();

    // Stopping an install that has finished leaves what it installed.
    const finishing = startToolbeltInstall(payload, env, report);
    await reported(reports, "bayma: installed");
    await finishing.stop();
    expect(installedVersion(env)).toBe("0.3.0\n");
    expect(reports.at(-1)).toStartWith("bayma: installed");
  });
});
