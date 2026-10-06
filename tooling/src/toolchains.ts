import { readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { provision } from "./provision/index.ts";
import { BUN_TOOLCHAIN } from "./provision/bun.ts";
import { CLANG_TOOLCHAIN } from "./provision/clang.ts";
import { DOTNET_TOOLCHAIN } from "./provision/dotnet.ts";
import { GO_TOOLCHAIN } from "./provision/go.ts";
import { LEAN_TOOLCHAIN } from "./provision/lean.ts";
import { isProvisioned, type Toolchain } from "./provision/payload.ts";
import { PYTHON_TOOLCHAIN } from "./provision/python.ts";
import { RUST_TOOLCHAIN } from "./provision/rust.ts";
import { TOOLBELT_TOOLCHAIN } from "./provision/toolbelt.ts";
import { ensureDir } from "./shared/files.ts";
import { sha256File, sha256Text } from "./shared/hashing.ts";
import { run, runOrThrow } from "./shared/process.ts";

// Every toolchain provisioning builds is kept as an image on GitHub's
// container registry, so CI provisions one only when what it is built from
// has changed. An image holds its toolchain's directories, at their paths
// under the work directory, and is tagged with the digest of what determines it:
// its identity, its pins, and the tooling that provisions it. A tag, once
// pushed, is never pushed again.

export const TOOLCHAINS_REPOSITORY = "ghcr.io/eaucoin/bayma-toolchains";
/** Links each image's package to this repository, whose workflows push it. */
const SOURCE = "https://github.com/eaucoin/bayma";
/** How many versions of each toolchain's image the registry keeps. */
export const KEPT_VERSIONS = 5;

/** In the order provisioning builds them: the toolbelt last. */
export const TOOLCHAINS: Toolchain[] = [
  BUN_TOOLCHAIN,
  PYTHON_TOOLCHAIN,
  DOTNET_TOOLCHAIN,
  RUST_TOOLCHAIN,
  CLANG_TOOLCHAIN,
  LEAN_TOOLCHAIN,
  GO_TOOLCHAIN,
  TOOLBELT_TOOLCHAIN,
];

const TOOLING_DIR = import.meta.dir;
const PLATFORMS_MODULE = join(TOOLING_DIR, "platforms.ts");
const TELEMETRY_DIR = join(TOOLING_DIR, "telemetry");

/**
 * The tooling modules `module` runs, itself included: every one its relative
 * imports reach, but the platform's pins, of which a toolchain names its own,
 * and telemetry, which records how provisioning went and changes nothing it
 * makes. Packages are not followed: provisioners take only names and path
 * rules from bayma's own, and following them would tie every toolchain to
 * all of bayma.
 */
export function provisioningModules(module: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const modules = new Set<string>();
  const visit = (path: string) => {
    if (modules.has(path)) return;
    modules.add(path);
    for (const { path: specifier } of transpiler.scanImports(
      readFileSync(path, "utf8"),
    )) {
      if (!specifier.startsWith(".")) continue;
      const imported = resolve(dirname(path), specifier);
      if (
        imported !== PLATFORMS_MODULE &&
        !imported.startsWith(TELEMETRY_DIR + sep)
      )
        visit(imported);
    }
  };
  visit(module);
  return [...modules].sort();
}

/** The digest of everything that determines `toolchain`, its image's tag. */
export function toolchainTag(repoRoot: string, toolchain: Toolchain): string {
  return sha256Text(
    JSON.stringify({
      identity: toolchain.identity(repoRoot),
      pins: toolchain.pins,
      modules: provisioningModules(toolchain.module).map((path) => [
        relative(TOOLING_DIR, path),
        sha256File(path),
      ]),
    }),
  );
}

export function toolchainImage(repoRoot: string, toolchain: Toolchain): string {
  return `${TOOLCHAINS_REPOSITORY}/${toolchain.name}:${toolchainTag(repoRoot, toolchain)}`;
}

function toolchainImages(repoRoot: string) {
  return TOOLCHAINS.map((toolchain) => ({
    toolchain,
    image: toolchainImage(repoRoot, toolchain),
  }));
}

/** What of the work directory a toolchain's image holds. */
function keptDirectories(toolchain: Toolchain): string[] {
  return [toolchain.directory, ...(toolchain.alongside ?? [])];
}

/** Whether the registry has `image`, and if not, what it answered. */
async function lookUp(
  image: string,
): Promise<{ found: boolean; answer: string }> {
  const { status, stderr } = await run([
    "docker",
    "manifest",
    "inspect",
    image,
  ]);
  return { found: status === 0, answer: stderr.trim() };
}

/**
 * Replaces the toolchain's directories with those `image` holds, modes and
 * links as they are there; returns the image by its digest.
 */
async function restore(
  workDir: string,
  toolchain: Toolchain,
  image: string,
): Promise<string> {
  await runOrThrow(["docker", "pull", "--quiet", image]);
  const pinned = (
    await runOrThrow([
      "docker",
      "image",
      "inspect",
      "--format",
      "{{index .RepoDigests 0}}",
      image,
    ])
  ).stdout.trim();
  // An image of files alone runs nothing, but a container is what they are
  // copied out of.
  const container = (
    await runOrThrow(["docker", "create", image, "none"])
  ).stdout.trim();
  try {
    for (const kept of keptDirectories(toolchain)) {
      const directory = join(workDir, kept);
      rmSync(directory, { recursive: true, force: true });
      ensureDir(dirname(directory));
      await runOrThrow([
        "bash",
        "-o",
        "pipefail",
        "-c",
        'docker cp "$1:/$2" - | tar -x --same-permissions -C "$3"',
        "restore",
        container,
        kept,
        dirname(directory),
      ]);
    }
  } finally {
    await runOrThrow(["docker", "rm", container]);
    // The files are in the work directory now; the image only takes disk.
    await runOrThrow(["docker", "image", "rm", image]);
  }
  return pinned;
}

/** Pushes the toolchain's directories as `image`, one layer of them alone. */
async function publish(
  workDir: string,
  toolchain: Toolchain,
  image: string,
): Promise<void> {
  await runOrThrow([
    "bash",
    "-o",
    "pipefail",
    "-c",
    'tar -c -C "$1" "${@:4}" | docker import --change "LABEL org.opencontainers.image.source=$2" - "$3"',
    "publish",
    workDir,
    SOURCE,
    image,
    ...keptDirectories(toolchain),
  ]);
  try {
    await runOrThrow(["docker", "push", "--quiet", image]);
  } finally {
    await runOrThrow(["docker", "image", "rm", image]);
  }
}

export interface PackageVersion {
  id: number;
  created_at: string;
}

/** The versions beyond the `kept` newest, which the registry need not keep. */
export function staleVersions<T extends PackageVersion>(
  versions: T[],
  kept: number,
): T[] {
  return [...versions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(kept);
}

/** Deletes all but the newest versions of the toolchain's image. */
async function prune(toolchain: Toolchain, token: string): Promise<number> {
  const [, owner, base] = TOOLCHAINS_REPOSITORY.split("/");
  const versions = `https://api.github.com/users/${owner}/packages/container/${encodeURIComponent(`${base}/${toolchain.name}`)}/versions`;
  const request = async (url: string, method = "GET") => {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok)
      throw new Error(
        `${method} ${url}: ${response.status} ${await response.text()}`,
      );
    return response;
  };
  const listed = (await (
    await request(`${versions}?per_page=100`)
  ).json()) as PackageVersion[];
  const stale = staleVersions(listed, KEPT_VERSIONS);
  for (const version of stale)
    await request(`${versions}/${version.id}`, "DELETE");
  return stale.length;
}

/**
 * Restores every toolchain into the work directory from its image, then
 * provisions, which finds each in place and only records them. Fails,
 * building nothing, when an image is missing or holds a directory built from
 * other inputs. Returns each image by its digest.
 */
export async function pullToolchains(
  repoRoot: string,
  workDir: string,
): Promise<Record<string, string>> {
  const images = toolchainImages(repoRoot);
  const lookups = await Promise.all(images.map(({ image }) => lookUp(image)));
  const missing = images.flatMap(({ image }, index) =>
    lookups[index]!.found ? [] : [`${image} (${lookups[index]!.answer})`],
  );
  if (missing.length > 0)
    throw new Error(
      `no image of ${missing.join(", ")}; the ci workflow's toolchains job pushes them, so run it on this commit first`,
    );
  const pinned = await Promise.all(
    images.map(({ toolchain, image }) => restore(workDir, toolchain, image)),
  );
  const context = {
    repoRoot,
    workDir,
    downloadsDir: join(workDir, "downloads"),
  };
  for (const { toolchain, image } of images) {
    const directory = join(workDir, toolchain.directory);
    if (!isProvisioned(context, directory, toolchain.identity(repoRoot)))
      throw new Error(
        `${image} holds a ${toolchain.name} built from other inputs`,
      );
  }
  await provision(repoRoot, workDir);
  return Object.fromEntries(
    images.map(({ toolchain }, index) => [toolchain.name, pinned[index]!]),
  );
}

/**
 * Pushes an image of each toolchain the registry lacks, provisioned from the
 * images of the rest, and prunes those images' older versions with `token`.
 * Returns what became of each toolchain, by name.
 */
export async function ensureToolchains(
  repoRoot: string,
  workDir: string,
  token: string,
): Promise<Record<string, string>> {
  const images = toolchainImages(repoRoot);
  const found = await Promise.all(
    images.map(async ({ image }) => (await lookUp(image)).found),
  );
  if (!found.every(Boolean)) {
    await Promise.all(
      images.map(({ toolchain, image }, index) =>
        found[index] ? restore(workDir, toolchain, image) : undefined,
      ),
    );
    await provision(repoRoot, workDir);
  }
  const outcomes = await Promise.all(
    images.map(async ({ toolchain, image }, index) => {
      // Another run may have pushed it since, and a tag is pushed once.
      if (found[index] || (await lookUp(image)).found)
        return `${image} is pushed`;
      await publish(workDir, toolchain, image);
      const pruned = await prune(toolchain, token);
      return `pushed ${image}, and pruned ${pruned} older versions`;
    }),
  );
  return Object.fromEntries(
    images.map(({ toolchain }, index) => [toolchain.name, outcomes[index]!]),
  );
}
