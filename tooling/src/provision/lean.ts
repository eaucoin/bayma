import { chmodSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LEAN } from "../platforms.ts";
import { fetchPinned } from "../shared/download.ts";
import { ensureDir } from "../shared/files.ts";
import { sha256File } from "../shared/hashing.ts";
import { runOrThrow } from "../shared/process.ts";
import { tarZstd } from "../shared/zstd.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
} from "./payload.ts";

// The Lean payload: Lean's release as it is, with bayma-lean-host built from
// this repository's sources against it. The release unpacks to the payload
// root, whose bin holds lean, lake, and the host.

const NATIVE_DIR = join("packages", "runtime-lean", "native");
/** The host's sources: everything its build reads. */
const HOST_SOURCES = ["BaymaLeanHost.lean", "lakefile.toml", "lean-toolchain"];
const HOST = "bayma-lean-host";

export async function provisionLean(
  context: ProvisionContext,
): Promise<RuntimePayload> {
  const root = join(context.workDir, "lean", "payload");
  const native = join(context.repoRoot, NATIVE_DIR);
  const identity = [
    LEAN.sha256,
    ...HOST_SOURCES.map((file) => sha256File(join(native, file))),
  ].join(":");
  if (!isProvisioned(context, root, identity)) {
    resetDirectory(root);
    ensureDir(root);
    const archive = await fetchPinned(
      LEAN,
      context.downloadsDir,
      `Lean ${LEAN.version}`,
    );
    await tarZstd(archive, ["-x", "-C", root, "--strip-components=1"]);
    const version = (await runOrThrow([join(root, "bin", "lean"), "--version"]))
      .stdout;
    if (!version.startsWith(`Lean (version ${LEAN.version},`)) {
      throw new Error(`pinned Lean reports ${version.trim()}`);
    }
    await buildHost(context, root, native);
    markProvisioned(root, identity);
  }
  return {
    runtimeId: "lean",
    root,
    env: { BAYMA_LEAN_VERSION: LEAN.version },
    envPaths: {
      BAYMA_LEAN_HOST_BIN: `bin/${HOST}`,
      BAYMA_LAKE_BIN: "bin/lake",
    },
    pathEnvPrepend: { PATH: ["bin"] },
    pins: { version: LEAN.version, sha256: LEAN.sha256, url: LEAN.url },
  };
}

/** Builds the host with the payload's own Lake, into the payload's bin. */
async function buildHost(
  context: ProvisionContext,
  root: string,
  native: string,
): Promise<void> {
  const named = readFileSync(join(native, "lean-toolchain"), "utf8").trim();
  if (named !== `leanprover/lean4:v${LEAN.version}`) {
    throw new Error(
      `${NATIVE_DIR}/lean-toolchain names ${named}, not the pinned Lean ${LEAN.version}`,
    );
  }
  const build = join(context.workDir, "lean", "host-build");
  resetDirectory(build);
  ensureDir(build);
  for (const file of HOST_SOURCES)
    copyFileSync(join(native, file), join(build, file));
  try {
    await runOrThrow([join(root, "bin", "lake"), "build"], {
      cwd: build,
      env: { PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` },
    });
    const host = join(root, "bin", HOST);
    copyFileSync(join(build, ".lake", "build", "bin", HOST), host);
    chmodSync(host, 0o755);
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}
