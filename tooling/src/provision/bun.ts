import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUN } from "../platforms.ts";
import { fetchPinned } from "../shared/download.ts";
import { runOrThrow } from "../shared/process.ts";
import { extractZipFlat } from "../shared/zip.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
  type Toolchain,
} from "./payload.ts";

// The Bun runtime runs its sessions in a Bun REPL. The payload carries the
// pinned Bun for this platform, not whatever Bun built the payload.

export const BUN_TOOLCHAIN: Toolchain = {
  name: "bun",
  directory: "bun",
  identity: () => BUN.sha256,
  pins: BUN,
  module: fileURLToPath(import.meta.url),
};

export async function provisionBun(
  context: ProvisionContext,
): Promise<RuntimePayload> {
  const directory = join(context.workDir, BUN_TOOLCHAIN.directory);
  const executable = join(directory, "bun");
  const identity = BUN_TOOLCHAIN.identity(context.repoRoot);
  if (!isProvisioned(context, directory, identity)) {
    resetDirectory(directory);
    mkdirSync(directory, { recursive: true });
    const archive = await fetchPinned(BUN, context.downloadsDir, "Bun");
    extractZipFlat(archive, directory);
    if (!existsSync(executable))
      throw new Error(`Bun archive did not contain ${executable}`);
    chmodSync(executable, 0o755);
    markProvisioned(directory, identity);
  }
  const version = (await runOrThrow([executable, "--version"])).stdout.trim();
  if (version !== BUN.version)
    throw new Error(`bundled Bun reports ${version}, expected ${BUN.version}`);
  return {
    runtimeId: "bun",
    root: directory,
    env: {},
    envPaths: { BAYMA_BUN_BIN: "bun" },
    pathEnvPrepend: { PATH: ["."] },
    pins: { version: BUN.version, sha256: BUN.sha256, url: BUN.url },
  };
}
