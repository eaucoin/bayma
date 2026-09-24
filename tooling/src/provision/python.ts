import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PYTHON } from "../platforms.ts";
import { fetchPinned } from "../shared/download.ts";
import { runOrThrow } from "../shared/process.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
} from "./payload.ts";

// A relocatable CPython from python-build-standalone. The archive unpacks to
// `python/`, which is the payload root as is.

export async function provisionPython(
  context: ProvisionContext,
): Promise<RuntimePayload> {
  const directory = join(context.workDir, "python");
  const root = join(directory, "python");
  const executable = join(root, "bin", "python3");
  if (!isProvisioned(context, directory, PYTHON.sha256)) {
    resetDirectory(directory);
    mkdirSync(directory, { recursive: true });
    const archive = await fetchPinned(
      PYTHON,
      context.downloadsDir,
      "portable Python",
    );
    await runOrThrow(["tar", "-xzf", archive, "-C", directory]);
    if (!existsSync(executable)) {
      throw new Error(`portable Python archive did not contain ${executable}`);
    }
    markProvisioned(directory, PYTHON.sha256);
  }
  const version = (await runOrThrow([executable, "--version"])).stdout.trim();
  if (version !== `Python ${PYTHON.version}`) {
    throw new Error(
      `portable Python reports ${version}, expected ${PYTHON.version}`,
    );
  }
  return {
    runtimeId: "python",
    root,
    // The interpreter finds its own prefix and libraries, so nothing but its
    // location reaches the shared environment every session inherits;
    // PYTHONHOME or LD_LIBRARY_PATH there would redirect any other Python a
    // session starts to this one's standard library.
    env: {},
    envPaths: { BAYMA_PYTHON_BIN: "bin/python3" },
    pathEnvPrepend: { PATH: ["bin"] },
    pins: { version: PYTHON.version, sha256: PYTHON.sha256, url: PYTHON.url },
  };
}
