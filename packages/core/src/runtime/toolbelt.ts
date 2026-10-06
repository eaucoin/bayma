import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { failureMessage } from "../errors.ts";
import { dataRoot, type PathEnvironment } from "../paths.ts";
import { inSpan } from "../telemetry/record.ts";
import { PAYLOAD_MANIFEST } from "./payload-environment.ts";
import {
  lockSqliteExclusively,
  SqliteLockContention,
  type ExclusiveSqliteLock,
} from "./sqlite.ts";

/**
 * The toolbelt: pinned Bun, Python, Rust, and C# packages that the runtime
 * skills load into sessions. It ships inside the payload, and bayma copies it
 * to one stable path under the user's data root, once per version, where the
 * skills name it and an agent can read it with its own tools: the payload
 * lives in bayma's image, which only bayma's own processes can see. A server
 * copies it in the background as it serves; `bayma install-toolbelt` and
 * `bayma doctor` copy it before they finish.
 */

export const TOOLBELT_DIR = "toolbelt";

/** The file in an installed toolbelt naming the version it was copied from. */
export const TOOLBELT_VERSION_FILE = ".bayma-toolbelt-version";

/**
 * The lock, beside the toolbelt path, that a bayma holds while it installs
 * the toolbelt there.
 */
export const TOOLBELT_INSTALL_LOCK = ".bayma-toolbelt-install.sqlite";

const VENV_BIN = join(".venv", "bin");
const INSTALL_LOCK_POLL_MS = 1_000;
// How many filesystem operations a copy of the toolbelt runs at once.
const COPY_CONCURRENCY = 32;
// How many files and directories an install copies between reports.
const PROGRESS_INTERVAL = 5_000;

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
 * What installs left beside the toolbelt path, `toolbelt.XXXXXX`: the
 * directories they assembled toolbelts in, and the toolbelts they moved
 * aside, `toolbelt.XXXXXX.replaced`.
 */
function leftovers(target: string): string[] {
  const parent = dirname(target);
  const left = new RegExp(
    `^${basename(target)}\\.[A-Za-z0-9]{6}(\\.replaced)?$`,
  );
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((name) => left.test(name))
    .map((name) => join(parent, name));
}

/**
 * Hold the lock a bayma installs the toolbelt at `target` under, once no
 * other bayma holds it. The operating system releases it when its holder
 * dies, so whoever holds it is a live bayma installing.
 */
async function lockInstalls(
  target: string,
  report: (message: string) => void,
  signal: AbortSignal | undefined,
): Promise<ExclusiveSqliteLock> {
  const path = join(dirname(target), TOOLBELT_INSTALL_LOCK);
  let reported = false;
  while (true) {
    signal?.throwIfAborted();
    try {
      return await lockSqliteExclusively(path);
    } catch (error) {
      if (!(error instanceof SqliteLockContention)) throw error;
    }
    if (!reported) {
      report(
        `bayma: waiting for another bayma to finish installing the toolbelt at ${target}`,
      );
      reported = true;
    }
    await sleep(INSTALL_LOCK_POLL_MS, undefined, { signal });
  }
}

/**
 * Install `payloadRoot`'s toolbelt at the toolbelt path unless the toolbelt
 * there is already this version's, and resolve to whether it did. The copy is
 * assembled beside the path and renamed into place, so a reader never sees
 * half of it, and is made without blocking the event loop. An abort of
 * `signal` stops it, and what it assembled is removed before it rejects.
 */
export async function installToolbelt(
  payloadRoot: string,
  env: PathEnvironment = process.env,
  report: (message: string) => void = () => undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  const source = join(payloadRoot, TOOLBELT_DIR);
  if (!existsSync(source)) return false;
  const version = payloadVersion(payloadRoot);
  const target = toolbeltPath(env);
  const installed = () => readVersion(join(target, TOOLBELT_VERSION_FILE));
  // A current toolbelt with nothing left beside it is only read, so a data
  // root no one may write to, such as one baked into an image, serves as is.
  if (installed() === version && leftovers(target).length === 0) return false;

  mkdirSync(dirname(target), { recursive: true });
  const lock = await lockInstalls(target, report, signal);
  try {
    return await inSpan("bayma.toolbelt.install", {}, async () => {
      // Only a bayma holding the lock installs, so what is left beside the
      // path was left by one that died installing.
      for (const left of leftovers(target)) {
        await rm(left, { recursive: true, force: true });
        report(`bayma: removed ${left}, which an interrupted install left`);
      }
      if (installed() === version) return false;
      await stageToolbelt(source, payloadRoot, version, target, report, signal);
      report(`bayma: installed the ${version} toolbelt at ${target}`);
      return true;
    });
  } finally {
    lock.close();
  }
}

/**
 * Runs the work it is given, at most `limit` at once, and none that has yet
 * to start once `signal` aborts.
 */
function limiter(
  limit: number,
  signal: AbortSignal | undefined,
): <T>(work: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (work) => {
    // A slot that frees passes straight to whoever waits longest.
    if (running < limit) running += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/** Throws the first failure among `results`, once all have settled. */
function settle(results: PromiseSettledResult<unknown>[]): void {
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * Copy what the directory `source` holds into the directory `target`: each
 * file's contents and mode, each directory's mode, and each link as it
 * reads. Many operations run at once, since on a filesystem slow with
 * metadata each one's latency, not its work, is what a copy waits on; an
 * abort of `signal` starts no more of them. `copied` is told of each file,
 * directory, and link copied.
 */
async function copyTree(
  source: string,
  target: string,
  signal: AbortSignal | undefined,
  copied: () => void,
): Promise<void> {
  const limit = limiter(COPY_CONCURRENCY, signal);
  const copyEntry = async (entry: Dirent, from: string, to: string) => {
    if (entry.isDirectory()) {
      await limit(() => mkdir(to));
      await copyInto(from, to);
    } else if (entry.isSymbolicLink()) {
      const link = await limit(() => readlink(from));
      await limit(() => symlink(link, to));
    } else if (entry.isFile()) {
      await limit(() => copyFile(from, to));
    } else {
      throw new Error(`${from} is not a file, a directory, or a link`);
    }
    copied();
  };
  const copyInto = async (from: string, to: string): Promise<void> => {
    const entries = await limit(() => readdir(from, { withFileTypes: true }));
    // Each entry's copy ends before the directory's fails, so a failure
    // leaves nothing being written for its caller to remove.
    settle(
      await Promise.allSettled(
        entries.map((entry) =>
          copyEntry(entry, join(from, entry.name), join(to, entry.name)),
        ),
      ),
    );
    // Last, so a directory whose mode forbids writing is filled first.
    const { mode } = await limit(() => stat(from));
    await limit(() => chmod(to, mode));
  };
  await copyInto(source, target);
}

/**
 * Copy `source`, the toolbelt of `payloadRoot` at `version`, beside `target`,
 * and rename the copy into place.
 */
async function stageToolbelt(
  source: string,
  payloadRoot: string,
  version: string,
  target: string,
  report: (message: string) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const staging = mkdtempSync(`${target}.`);
  const replaced = `${staging}.replaced`;
  try {
    report(`bayma: installing the ${version} toolbelt at ${target}`);
    let copied = 0;
    await copyTree(source, staging, signal, () => {
      copied += 1;
      if (copied % PROGRESS_INTERVAL === 0)
        report(
          `bayma: copied ${copied} of the toolbelt's files and directories`,
        );
    });
    relocateToolbelt(staging, payloadRoot);
    writeFileSync(join(staging, TOOLBELT_VERSION_FILE), version + "\n");
    // Whatever held the path before, an older toolbelt or the link an earlier
    // install made, moves aside first: a directory is not renamed over.
    if (existsSync(target) || isLink(target)) renameSync(target, replaced);
    renameSync(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(replaced, { recursive: true, force: true });
  }
}

/** A toolbelt install running while bayma does other work. */
export interface ToolbeltInstall {
  /**
   * Stop the install if it is still running, resolving once nothing it
   * assembled is left.
   */
  stop(): Promise<void>;
}

/**
 * Install the toolbelt as `installToolbelt` does, while the caller goes on,
 * as a server serves its clients meanwhile: sessions run from the payload,
 * and only what the runtime skills load from the toolbelt path waits for it.
 * A failure is reported rather than thrown.
 */
export function startToolbeltInstall(
  payloadRoot: string,
  env: PathEnvironment,
  report: (message: string) => void,
): ToolbeltInstall {
  const stopping = new AbortController();
  const settled = installToolbelt(
    payloadRoot,
    env,
    report,
    stopping.signal,
  ).then(
    () => undefined,
    (error: unknown) =>
      report(
        stopping.signal.aborted
          ? "bayma: stopped installing the toolbelt, which the next start installs"
          : `bayma: installing the toolbelt failed: ${failureMessage(error)}`,
      ),
  );
  return {
    stop() {
      stopping.abort();
      return settled;
    },
  };
}

function isLink(path: string): boolean {
  try {
    readlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
