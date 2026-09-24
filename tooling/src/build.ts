import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { readJson } from "./shared/files.ts";
import { runOrThrow } from "./shared/process.ts";
import { assertBundleUntraced } from "./telemetry/boundary.ts";
import { recordArtifact } from "./telemetry/index.ts";

// The published package is packages/server; its manifest is the one source
// of the product version and of what the tarball contains.
export const PACKAGE_DIR = "packages/server";
const ENTRYPOINT = join(PACKAGE_DIR, "src", "main.ts");
const INSTALL_ENTRYPOINT = join(PACKAGE_DIR, "src", "install.ts");
export const BUNDLE = "bayma.js";
export const INSTALLER = "install.js";

// Node prints an ExperimentalWarning for node:sqlite on every start; the
// state-directory lease is the one thing bayma uses it for, and the warning
// would otherwise land in every MCP client's log.
const SHEBANG = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";

export interface PackageManifest {
  name: string;
  version: string;
  [field: string]: unknown;
}

export function packageManifest(repoRoot: string): PackageManifest {
  const manifest = readJson<PackageManifest>(
    join(repoRoot, PACKAGE_DIR, "package.json"),
  );
  // The engine reports BAYMA_VERSION from its own manifest, and the payload a
  // release publishes is keyed by the published version; a divergence would
  // send an install looking for a payload nobody built.
  const engine = readJson<PackageManifest>(
    join(repoRoot, "packages", "core", "package.json"),
  );
  if (manifest.version !== engine.version) {
    throw new Error(
      `the published version ${manifest.version} does not match the engine's ${engine.version}`,
    );
  }
  return manifest;
}

export interface BuildResult {
  version: string;
  bundle: string;
  installer: string;
}

async function bundleForNode(
  repoRoot: string,
  entrypoint: string,
  outFile: string,
): Promise<void> {
  await runOrThrow(
    [
      "bun",
      "build",
      join(repoRoot, entrypoint),
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "bun:sqlite",
      "--banner",
      SHEBANG,
      "--outfile",
      outFile,
    ],
    { cwd: repoRoot },
  );
  if (
    !existsSync(outFile) ||
    !readFileSync(outFile, "utf8").startsWith(SHEBANG)
  )
    throw new Error(`bun build produced no bundle at ${outFile}`);
  assertBundleUntraced(outFile);
  chmodSync(outFile, 0o755);
  recordArtifact(basename(outFile), statSync(outFile).size);
}

/** Bundle the server and the installer; the server must report the version. */
export async function build(
  repoRoot: string,
  outDir: string,
): Promise<BuildResult> {
  const { version } = packageManifest(repoRoot);
  mkdirSync(outDir, { recursive: true });
  const bundle = join(outDir, BUNDLE);
  const installer = join(outDir, INSTALLER);
  await bundleForNode(repoRoot, ENTRYPOINT, bundle);
  await bundleForNode(repoRoot, INSTALL_ENTRYPOINT, installer);
  const reported = (
    await runOrThrow(["node", bundle, "version"])
  ).stdout.trim();
  if (reported !== version) {
    throw new Error(
      `${BUNDLE} reports version ${reported}, expected ${version}`,
    );
  }
  return { version, bundle, installer };
}
