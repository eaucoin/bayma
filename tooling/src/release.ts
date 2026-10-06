import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_PACKAGE_DIR } from "./cli-package.ts";

// Pinning the bayma command to a release's image: the release workflow,
// once it has pushed the image, writes its digest into the command's
// release module, which holds nothing else, and then builds the command.

export const RELEASE_MODULE = join(CLI_PACKAGE_DIR, "src", "release.ts");

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** packages/cli/src/release.ts pinned to `digest`, or to none when it is empty. */
export function releaseModule(digest: string): string {
  if (digest !== "" && !DIGEST.test(digest))
    throw new Error(`${digest} is not a sha256 digest`);
  return `import packageJson from "../package.json" with { type: "json" };

// What this version of the bayma package runs: bayma's image of the same
// version, pinned by digest. The release workflow writes the digest of the
// image it pushed here, with \`bun run pin\`, before it builds the package;
// between releases none is pinned.

export const VERSION = packageJson.version;

export const IMAGE_REPOSITORY = "ghcr.io/eaucoin/bayma";

export const IMAGE_DIGEST = ${JSON.stringify(digest)};
`;
}

/** Pins the command in `repoRoot` to the image of `digest`. */
export function pinRelease(repoRoot: string, digest: string): string {
  const path = join(repoRoot, RELEASE_MODULE);
  writeFileSync(path, releaseModule(digest));
  return path;
}
