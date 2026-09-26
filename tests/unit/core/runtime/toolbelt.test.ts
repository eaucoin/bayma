import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  bindToolbelt,
  installToolbelt,
  PAYLOAD_MANIFEST,
  TOOLBELT_DIR,
  TOOLBELT_VERSION_FILE,
  toolbeltPath,
} from "@bayma/core";
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
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    const reports: string[] = [];

    installToolbelt(payload, env, (message) => reports.push(message));

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
      `bayma: installed the 0.3.0 toolbelt at ${installed}`,
    ]);
    // Nothing of the install is left beside the toolbelt.
    expect(readdirSync(dirname(installed))).toEqual([TOOLBELT_DIR]);
  });
});

test("a toolbelt already installed from the same version is left as it is", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    installToolbelt(payload, env);
    const marker = join(toolbeltPath(env), "left-by-an-earlier-install");
    writeFileSync(marker, "");
    const reports: string[] = [];

    installToolbelt(payload, env, (message) => reports.push(message));

    expect(existsSync(marker)).toBe(true);
    expect(reports).toEqual([]);
  });
});

test("another version's toolbelt is replaced whole", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    installToolbelt(writePayload(root, "0.10.0"), env);
    const stale = join(toolbeltPath(env), "only-in-0.10.0");
    writeFileSync(stale, "");

    // Whichever version starts, its own toolbelt is what the skills load.
    installToolbelt(writePayload(root, "0.3.0"), env);

    expect(installedVersion(env)).toBe("0.3.0\n");
    expect(existsSync(stale)).toBe(false);
    expect(
      readFileSync(
        join(toolbeltPath(env), "node_modules", "package", "index.js"),
        "utf8",
      ),
    ).toBe('export const version = "0.3.0";\n');
    expect(readdirSync(dirname(toolbeltPath(env)))).toEqual([TOOLBELT_DIR]);
  });
});

test("the link an earlier bayma made at the toolbelt path is replaced by a copy", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const earlier = writePayload(root, "0.2.0");
    mkdirSync(dirname(toolbeltPath(env)), { recursive: true });
    symlinkSync(join(earlier, TOOLBELT_DIR), toolbeltPath(env));

    installToolbelt(writePayload(root, "0.3.0"), env);

    expect(lstatSync(toolbeltPath(env)).isDirectory()).toBe(true);
    expect(installedVersion(env)).toBe("0.3.0\n");
    // The payload the link named is not touched.
    expect(existsSync(join(earlier, TOOLBELT_DIR, "node_modules"))).toBe(true);
  });
});

test("the installed toolbelt's Python environment runs the payload's interpreter", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    writeVenv(payload);

    installToolbelt(payload, env);

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
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = join(root, "payloads", "0.2.3");
    mkdirSync(payload, { recursive: true });

    installToolbelt(payload, env);

    expect(existsSync(toolbeltPath(env))).toBe(false);
  });
});

test("a payload whose manifest names no version is refused", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = writePayload(root, "0.3.0");
    writeFileSync(join(payload, PAYLOAD_MANIFEST), JSON.stringify({}));

    expect(() => installToolbelt(payload, env)).toThrow(
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
