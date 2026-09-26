import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE, packageManifest } from "./build.ts";
import { PAYLOAD_MANIFEST, type PayloadManifest } from "./payload.ts";
import { readJson } from "./shared/files.ts";
import { runOrThrow } from "./shared/process.ts";
import { recordArtifact, telemetryEnabled } from "./telemetry/index.ts";

// bayma's image: the server bundle and the payload, built from the
// repository's Dockerfile with the repository as its context. Publishing it
// is the release workflow's; this builds and tags it.

export const IMAGE_REPOSITORIES = ["bayma", "ghcr.io/eaucoin/bayma"] as const;

/** Every tag the image is built with: each repository at `version`. */
export function imageTags(version: string): string[] {
  return IMAGE_REPOSITORIES.map((repository) => `${repository}:${version}`);
}

/** The `docker build` that builds the image in `repoRoot` with `tags`. */
export function imageBuildCommand(repoRoot: string, tags: string[]): string[] {
  return [
    "docker",
    "build",
    "--platform",
    "linux/amd64",
    "--file",
    join(repoRoot, "Dockerfile"),
    ...tags.flatMap((tag) => ["--tag", tag]),
    repoRoot,
  ];
}

/**
 * Build the image from dist's bundle and payload, which must be this
 * version's; returns its tags.
 */
export async function buildImage(
  repoRoot: string,
  distDir: string,
): Promise<string[]> {
  const { version } = packageManifest(repoRoot);
  const bundle = join(distDir, BUNDLE);
  const payload = join(distDir, "payload", PAYLOAD_MANIFEST);
  if (!existsSync(bundle))
    throw new Error(`${bundle} is missing; run \`bun run build\` first`);
  if (!existsSync(payload))
    throw new Error(`${payload} is missing; run \`bun run payload\` first`);
  // An image is tagged with one version, and everything in it must be that
  // version's.
  const bundled = (await runOrThrow(["node", bundle, "version"])).stdout.trim();
  if (bundled !== version)
    throw new Error(
      `${BUNDLE} is ${bundled}, not ${version}; run \`bun run build\``,
    );
  const assembled = readJson<PayloadManifest>(payload).version;
  if (assembled !== version)
    throw new Error(
      `the payload is ${assembled}, not ${version}; run \`bun run payload\``,
    );
  const tags = imageTags(version);
  await runOrThrow(imageBuildCommand(repoRoot, tags), {
    cwd: repoRoot,
    echo: true,
  });
  if (telemetryEnabled())
    recordArtifact(
      "image",
      Number(
        (
          await runOrThrow([
            "docker",
            "image",
            "inspect",
            "--format",
            "{{.Size}}",
            tags[0]!,
          ])
        ).stdout,
      ),
    );
  return tags;
}
