import { expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  bindToolbelt,
  linkToolbelt,
  PAYLOAD_MANIFEST,
  TOOLBELT_DIR,
  toolbeltPath,
} from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

/** An installed payload of `version` that carries a toolbelt. */
function writePayload(root: string, version: string): string {
  const payload = join(root, "payloads", version);
  mkdirSync(join(payload, TOOLBELT_DIR), { recursive: true });
  writeFileSync(join(payload, PAYLOAD_MANIFEST), JSON.stringify({ version }));
  return payload;
}

test("the toolbelt path lives under bayma's data root", () => {
  expect(toolbeltPath({ HOME: "/home/someone" })).toBe(
    "/home/someone/.local/share/bayma/toolbelt",
  );
  expect(toolbeltPath({ XDG_DATA_HOME: "/xdg/data" })).toBe(
    "/xdg/data/bayma/toolbelt",
  );
});

test("the newest installed payload's toolbelt holds the link", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const older = writePayload(root, "0.3.0");
    const newer = writePayload(root, "0.10.0");

    linkToolbelt(older, env);
    expect(readlinkSync(toolbeltPath(env))).toBe(join(older, TOOLBELT_DIR));

    linkToolbelt(newer, env);
    expect(readlinkSync(toolbeltPath(env))).toBe(join(newer, TOOLBELT_DIR));

    // A server of the older version starting later leaves the link alone.
    linkToolbelt(older, env);
    expect(readlinkSync(toolbeltPath(env))).toBe(join(newer, TOOLBELT_DIR));
  });
});

test("a link to a removed payload is replaced", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    mkdirSync(join(root, "data", "bayma"), { recursive: true });
    symlinkSync(
      join(root, "payloads", "9.9.9", TOOLBELT_DIR),
      toolbeltPath(env),
    );
    const payload = writePayload(root, "0.3.0");

    linkToolbelt(payload, env);

    expect(readlinkSync(toolbeltPath(env))).toBe(join(payload, TOOLBELT_DIR));
  });
});

test("something other than bayma's link is reported and left alone", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    mkdirSync(toolbeltPath(env), { recursive: true });
    const reports: string[] = [];

    linkToolbelt(writePayload(root, "0.3.0"), env, (message) =>
      reports.push(message),
    );

    expect(() => readlinkSync(toolbeltPath(env))).toThrow();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("is not bayma's link to its toolbelt");
  });
});

test("a payload without a toolbelt links nothing", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const env = { XDG_DATA_HOME: join(root, "data") };
    const payload = join(root, "payloads", "0.2.3");
    mkdirSync(payload, { recursive: true });

    linkToolbelt(payload, env);

    expect(() => readlinkSync(toolbeltPath(env))).toThrow();
  });
});

test("binding points the toolbelt's environment at the payload's interpreter where the payload will run", async () => {
  await withTempDir((dir) => {
    const root = realpathSync(dir);
    const staged = writePayload(root, "0.3.1");
    const bin = join(staged, TOOLBELT_DIR, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(
      join("..", "..", "..", "python", "bin", "python3"),
      join(bin, "python"),
    );
    const config = join(staged, TOOLBELT_DIR, ".venv", "pyvenv.cfg");
    writeFileSync(
      config,
      "home = /build/.work/python/python/bin\nrelocatable = true\n",
    );
    const installed = join(root, "payloads", "installed");

    bindToolbelt(staged, installed);

    expect(readFileSync(config, "utf8")).toBe(
      `home = ${join(installed, "python", "bin")}\nrelocatable = true\n`,
    );
  });
});

test("binding a payload without a toolbelt environment changes nothing", async () => {
  await withTempDir((dir) => {
    const payload = writePayload(realpathSync(dir), "0.3.1");

    expect(() => bindToolbelt(payload)).not.toThrow();
  });
});
