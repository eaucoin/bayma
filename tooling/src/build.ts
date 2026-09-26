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

// The server is packages/server; its manifest is the one source of the
// product version, which the image is tagged with.
export const PACKAGE_DIR = "packages/server";
const ENTRYPOINT = join(PACKAGE_DIR, "src", "main.ts");
export const BUNDLE = "bayma.js";

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
  // The engine reports BAYMA_VERSION from its own manifest, and the image and
  // its payload are tagged with the server's; a divergence would ship an
  // image that reports a version other than its tag.
  const engine = readJson<PackageManifest>(
    join(repoRoot, "packages", "core", "package.json"),
  );
  if (manifest.version !== engine.version) {
    throw new Error(
      `the server's version ${manifest.version} does not match the engine's ${engine.version}`,
    );
  }
  return manifest;
}

export interface BuildResult {
  version: string;
  bundle: string;
}

/** Bundle the server for Node; the bundle must report the version. */
export async function build(
  repoRoot: string,
  outDir: string,
): Promise<BuildResult> {
  const { version } = packageManifest(repoRoot);
  mkdirSync(outDir, { recursive: true });
  const bundle = join(outDir, BUNDLE);
  await runOrThrow(
    [
      "bun",
      "build",
      join(repoRoot, ENTRYPOINT),
      "--target",
      "node",
      "--format",
      "esm",
      "--external",
      "bun:sqlite",
      "--banner",
      SHEBANG,
      "--outfile",
      bundle,
    ],
    { cwd: repoRoot },
  );
  if (!existsSync(bundle) || !readFileSync(bundle, "utf8").startsWith(SHEBANG))
    throw new Error(`bun build produced no bundle at ${bundle}`);
  assertBundleUntraced(bundle);
  chmodSync(bundle, 0o755);
  recordArtifact(basename(bundle), statSync(bundle).size);
  const reported = (
    await runOrThrow(["node", bundle, "version"])
  ).stdout.trim();
  if (reported !== version) {
    throw new Error(
      `${BUNDLE} reports version ${reported}, expected ${version}`,
    );
  }
  return { version, bundle };
}
