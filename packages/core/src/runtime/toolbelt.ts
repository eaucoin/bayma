import {
  existsSync,
  lstatSync,
  mkdirSync,
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
 * The toolbelt: pinned Bun, Python, and Rust packages that the bayma-toolbelt
 * skill loads into sessions. It ships inside the payload, and one stable path
 * under bayma's data root links to the newest installed payload's copy, so
 * the skill names a single path whatever versions a machine has installed.
 */

export const TOOLBELT_DIR = "toolbelt";

export function toolbeltPath(env: PathEnvironment = process.env): string {
  return join(dataRoot(env), TOOLBELT_DIR);
}

/**
 * Bind the toolbelt's Python environment to where its payload lives. The
 * environment's interpreter link is relative, but Python finds that
 * interpreter's platform libraries through the `home` its `pyvenv.cfg` names
 * by absolute path, so a payload carries the path it was built at until it is
 * bound. `payloadFiles` holds the payload now; `payloadRoot` is where it will
 * run from, when an install stages it elsewhere first.
 */
export function bindToolbelt(
  payloadFiles: string,
  payloadRoot: string = payloadFiles,
): void {
  const venv = join(TOOLBELT_DIR, ".venv");
  const config = join(payloadFiles, venv, "pyvenv.cfg");
  if (!existsSync(config)) return;
  const bin = join(venv, "bin");
  const interpreter = resolve(
    join(payloadRoot, bin),
    readlinkSync(join(payloadFiles, bin, "python")),
  );
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      /^home\s*=.*$/m,
      `home = ${dirname(interpreter)}`,
    ),
  );
}

function payloadVersion(payloadRoot: string): number[] | undefined {
  try {
    const { version } = JSON.parse(
      readFileSync(join(payloadRoot, PAYLOAD_MANIFEST), "utf8"),
    ) as { version?: unknown };
    return typeof version === "string"
      ? version.split(".").map(Number)
      : undefined;
  } catch {
    return undefined;
  }
}

function isNewer(candidate: number[], current: number[]): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const difference = candidate[index]! - (current[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/**
 * Point the toolbelt path at `payloadRoot`'s toolbelt unless it already names
 * a newer installed one. Only bayma's own symlink is ever replaced: anything
 * else at that path is reported and left alone.
 */
export function linkToolbelt(
  payloadRoot: string,
  env: PathEnvironment = process.env,
  report: (message: string) => void = () => undefined,
): void {
  const target = join(payloadRoot, TOOLBELT_DIR);
  const link = toolbeltPath(env);
  if (!existsSync(target)) return;
  let current: string | undefined;
  try {
    if (!lstatSync(link).isSymbolicLink()) {
      report(
        `bayma: ${link} is not bayma's link to its toolbelt; remove it to let bayma install the toolbelt there`,
      );
      return;
    }
    current = readlinkSync(link);
  } catch {
    // No link yet.
  }
  if (current === target) return;
  if (current !== undefined && existsSync(current)) {
    const installed = payloadVersion(dirname(current));
    const offered = payloadVersion(payloadRoot);
    if (installed && offered && !isNewer(offered, installed)) return;
  }
  mkdirSync(dirname(link), { recursive: true });
  // A symlink renamed over the old one replaces it atomically.
  const staging = `${link}.${process.pid}`;
  rmSync(staging, { force: true });
  symlinkSync(target, staging);
  renameSync(staging, link);
}
