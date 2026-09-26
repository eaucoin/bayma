import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataRoot, type PathEnvironment } from "../paths.ts";
import { PAYLOAD_MANIFEST } from "./payload-environment.ts";

/**
 * The toolbelt: pinned Bun, Python, Rust, and C# packages that the runtime
 * skills load into sessions. It ships inside the payload, and bayma copies it
 * to one stable path under the user's data root, once per version, where the
 * skills name it and an agent can read it with its own tools: the payload
 * lives in bayma's image, which only bayma's own processes can see.
 */

export const TOOLBELT_DIR = "toolbelt";

/** The file in an installed toolbelt naming the version it was copied from. */
export const TOOLBELT_VERSION_FILE = ".bayma-toolbelt-version";

const VENV_BIN = join(".venv", "bin");

export function toolbeltPath(env: PathEnvironment = process.env): string {
  return join(dataRoot(env), TOOLBELT_DIR);
}

/**
 * Bind the toolbelt's Python environment to where its payload lives. The
 * environment's interpreter link is relative, but Python finds that
 * interpreter's platform libraries through the `home` its `pyvenv.cfg` names
 * by absolute path, so a payload carries the path it was built at until it is
 * bound. `payloadFiles` holds the payload now; `payloadRoot` is where it will
 * run from, when it is staged elsewhere first.
 */
export function bindToolbelt(
  payloadFiles: string,
  payloadRoot: string = payloadFiles,
): void {
  const toolbelt = join(payloadFiles, TOOLBELT_DIR);
  const config = join(toolbelt, ".venv", "pyvenv.cfg");
  if (!existsSync(config)) return;
  const interpreter = resolve(
    join(payloadRoot, TOOLBELT_DIR, VENV_BIN),
    readlinkSync(join(toolbelt, VENV_BIN, "python")),
  );
  setVenvHome(toolbelt, interpreter);
}

function setVenvHome(toolbelt: string, interpreter: string): void {
  const config = join(toolbelt, ".venv", "pyvenv.cfg");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      /^home\s*=.*$/m,
      `home = ${dirname(interpreter)}`,
    ),
  );
}

/**
 * Point a copy of the payload's toolbelt at the payload's interpreter: its
 * environment's interpreter link is relative to the payload, so the copy's
 * link, and the `home` its `pyvenv.cfg` names, become absolute paths into it.
 */
function relocateToolbelt(copy: string, payloadRoot: string): void {
  const link = join(copy, VENV_BIN, "python");
  if (!existsSync(join(copy, ".venv", "pyvenv.cfg"))) return;
  const interpreter = resolve(
    join(payloadRoot, TOOLBELT_DIR, VENV_BIN),
    readlinkSync(link),
  );
  rmSync(link);
  symlinkSync(interpreter, link);
  setVenvHome(copy, interpreter);
}

function readVersion(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function payloadVersion(payloadRoot: string): string {
  const { version } = JSON.parse(
    readFileSync(join(payloadRoot, PAYLOAD_MANIFEST), "utf8"),
  ) as { version?: unknown };
  if (typeof version !== "string" || !version) {
    throw new Error(`${PAYLOAD_MANIFEST} names no version: ${payloadRoot}`);
  }
  return version;
}

/**
 * Install `payloadRoot`'s toolbelt at the toolbelt path unless the toolbelt
 * there is already this version's. The copy is assembled beside the path and
 * renamed into place, so a reader never sees half of it.
 */
export function installToolbelt(
  payloadRoot: string,
  env: PathEnvironment = process.env,
  report: (message: string) => void = () => undefined,
): void {
  const source = join(payloadRoot, TOOLBELT_DIR);
  if (!existsSync(source)) return;
  const version = payloadVersion(payloadRoot);
  const target = toolbeltPath(env);
  const installed = () => readVersion(join(target, TOOLBELT_VERSION_FILE));
  if (installed() === version) return;

  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(`${target}.`);
  const replaced = `${staging}.replaced`;
  try {
    cpSync(source, staging, {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
    relocateToolbelt(staging, payloadRoot);
    writeFileSync(join(staging, TOOLBELT_VERSION_FILE), version + "\n");
    // Whatever held the path before, an older toolbelt or the link an earlier
    // install made, moves aside first: a directory is not renamed over.
    if (existsSync(target) || isLink(target)) renameSync(target, replaced);
    try {
      renameSync(staging, target);
    } catch (error) {
      // Another bayma installed this version's toolbelt first.
      if (installed() !== version) throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(replaced, { recursive: true, force: true });
  }
  report(`bayma: installed the ${version} toolbelt at ${target}`);
}

function isLink(path: string): boolean {
  try {
    readlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
