import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type BuildResult,
  type PackageManifest,
  packageManifest,
} from "./build.ts";
import { readJson } from "./shared/files.ts";
import { runOrThrow } from "./shared/process.ts";
import { recordArtifact } from "./telemetry/index.ts";

// The bayma command, packages/cli, published to npm as `bayma`: one file run
// by whatever Node 22 or later npx runs, with nothing installed beside it.
// It runs bayma's image of its own version, so its version is the server's.

export const CLI_PACKAGE_DIR = "packages/cli";
const CLI_ENTRYPOINT = join(CLI_PACKAGE_DIR, "src", "main.ts");
/** The bundle, as the package's manifest names it for its `bayma` command. */
export const CLI_BUNDLE = join(CLI_PACKAGE_DIR, "dist", "bayma.js");
const CLI_SHEBANG = "#!/usr/bin/env node";

export function cliManifest(repoRoot: string): PackageManifest {
  const manifest = readJson<PackageManifest>(
    join(repoRoot, CLI_PACKAGE_DIR, "package.json"),
  );
  const { version } = packageManifest(repoRoot);
  if (manifest.version !== version)
    throw new Error(
      `the bayma command's version ${manifest.version} does not match the server's ${version}`,
    );
  return manifest;
}

/** The modules a bundle imports; a self-contained one imports Node's alone. */
export function bundleImports(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)"([^"]+)"/g,
    ),
  ].map(([, specifier]) => specifier!);
}

/**
 * Bundle the bayma command for Node; the bundle must import nothing but
 * Node's own modules, and report the version.
 */
export async function buildCli(repoRoot: string): Promise<BuildResult> {
  const { version } = cliManifest(repoRoot);
  const bundle = join(repoRoot, CLI_BUNDLE);
  await runOrThrow(
    [
      "bun",
      "build",
      join(repoRoot, CLI_ENTRYPOINT),
      "--target",
      "node",
      "--format",
      "esm",
      "--banner",
      CLI_SHEBANG,
      "--outfile",
      bundle,
    ],
    { cwd: repoRoot },
  );
  if (!existsSync(bundle))
    throw new Error(`bun build produced no bundle at ${bundle}`);
  const source = readFileSync(bundle, "utf8");
  if (!source.startsWith(CLI_SHEBANG))
    throw new Error(`${bundle} does not start with ${CLI_SHEBANG}`);
  const foreign = bundleImports(source).filter(
    (specifier) => !specifier.startsWith("node:"),
  );
  if (foreign.length > 0)
    throw new Error(
      `${bundle} imports ${foreign.join(", ")}, which the bayma package does not ship`,
    );
  chmodSync(bundle, 0o755);
  recordArtifact(basename(CLI_PACKAGE_DIR), statSync(bundle).size);
  const reported = (
    await runOrThrow(["node", bundle, "version"])
  ).stdout.trim();
  if (reported !== version)
    throw new Error(
      `${bundle} reports version ${reported}, expected ${version}`,
    );
  return { version, bundle };
}
