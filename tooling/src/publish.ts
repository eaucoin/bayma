import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { PLATFORM_IDS, type PlatformId } from "@bayma/core";
import { BUNDLE, INSTALLER, packageManifest } from "./build.ts";
import { payloadTarballName } from "./payload.ts";
import { writeJson } from "./shared/files.ts";
import { sha256File } from "./shared/hashing.ts";
import { runOrThrow } from "./shared/process.ts";

// The published package: the manifest from packages/server, the two Node
// bundles, and the pinned release each platform's payload is downloaded from.
// Nothing else — the toolchains, including the Rust host, are in the payload.

export const PAYLOAD_RELEASE_MANIFEST = "payloads.json";
const RELEASE_ASSET_BASE = "https://github.com/eaucoin/bayma/releases/download";

/** Where the tarball an install downloads lives, once the release exists. */
export function payloadAssetUrl(version: string, platform: PlatformId): string {
  return `${RELEASE_ASSET_BASE}/v${version}/${payloadTarballName(platform, version)}`;
}

export interface PayloadRelease {
  version: string;
  payloads: Record<string, { url: string; sha256: string; bytes: number }>;
}

export interface PayloadReleaseOptions {
  /** Where the assets will be served from; the GitHub release by default. */
  baseUrl?: string;
  /**
   * The platforms that must be present. A published release requires every
   * one of them; a local or single-runner build asks for its own.
   */
  platforms?: readonly PlatformId[];
}

/**
 * Describe the payload tarballs in `assetsDir` so the package can verify what
 * it downloads.
 */
export function writePayloadRelease(
  repoRoot: string,
  assetsDir: string,
  outDir: string,
  options: PayloadReleaseOptions = {},
): PayloadRelease {
  const { baseUrl, platforms = PLATFORM_IDS } = options;
  const { version } = packageManifest(repoRoot);
  const found = new Map<PlatformId, string>();
  for (const name of existsSync(assetsDir) ? readdirSync(assetsDir) : []) {
    for (const platform of PLATFORM_IDS) {
      if (name === payloadTarballName(platform, version))
        found.set(platform, join(assetsDir, name));
    }
  }
  const missing = platforms.filter((platform) => !found.has(platform));
  if (missing.length > 0) {
    throw new Error(
      `no payload tarball for ${missing.join(", ")} in ${assetsDir}`,
    );
  }
  const release: PayloadRelease = {
    version,
    payloads: Object.fromEntries(
      [...found]
        .filter(([platform]) => platforms.includes(platform))
        .map(([platform, path]) => [
          platform,
          {
            url: baseUrl
              ? `${baseUrl}/${payloadTarballName(platform, version)}`
              : payloadAssetUrl(version, platform),
            sha256: sha256File(path),
            bytes: statSync(path).size,
          },
        ]),
    ),
  };
  mkdirSync(outDir, { recursive: true });
  writeJson(join(outDir, PAYLOAD_RELEASE_MANIFEST), release);
  return release;
}

/** Where a member of the tarball may live; anything else is a packing error. */
const ALLOWED_MEMBERS =
  /^(?:package\.json|README\.md|LICENSE|dist\/(?:bayma\.js|install\.js|payloads\.json))$/;

export interface PackResult {
  tarball: string;
  files: string[];
}

export function stagePackage(repoRoot: string, stageDir: string): void {
  const manifest = packageManifest(repoRoot);
  const { devDependencies: _workspaceOnly, ...published } = manifest;
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, "dist"), { recursive: true });
  writeJson(join(stageDir, "package.json"), {
    ...published,
    // Only the published package installs a payload; a workspace checkout
    // provisions one instead.
    scripts: { postinstall: `node dist/${INSTALLER}` },
  });
  for (const file of [BUNDLE, INSTALLER, PAYLOAD_RELEASE_MANIFEST]) {
    const source = join(repoRoot, "dist", file);
    if (!existsSync(source))
      throw new Error(`run build and release first: ${source} is missing`);
    cpSync(source, join(stageDir, "dist", file));
  }
  for (const file of ["README.md", "LICENSE"]) {
    cpSync(join(repoRoot, file), join(stageDir, file));
  }
}

export function pack(repoRoot: string, distDir: string): PackResult {
  const stageDir = join(distDir, "npm", "package");
  stagePackage(repoRoot, stageDir);
  // One package tarball in dist, so what is there is what was built.
  for (const name of readdirSync(distDir)) {
    if (name.endsWith(".tgz")) rmSync(join(distDir, name), { force: true });
  }
  const [report] = JSON.parse(
    runOrThrow(["npm", "pack", "--json", "--pack-destination", distDir], {
      cwd: stageDir,
    }).stdout,
  ) as [{ filename: string; files: { path: string }[] }];
  const files = report.files.map(({ path }) => path).sort();
  const stray = files.filter((path) => !ALLOWED_MEMBERS.test(path));
  if (stray.length > 0) {
    throw new Error(`tarball contains files it must not:\n${stray.join("\n")}`);
  }
  return { tarball: join(distDir, report.filename), files };
}
