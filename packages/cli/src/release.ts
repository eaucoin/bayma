import packageJson from "../package.json" with { type: "json" };

// What this version of the bayma package runs: bayma's image of the same
// version, pinned by digest. The release workflow writes the digest of the
// image it pushed here, with `bun run pin`, before it builds the package;
// between releases none is pinned.

export const VERSION = packageJson.version;

export const IMAGE_REPOSITORY = "ghcr.io/eaucoin/bayma";

export const IMAGE_DIGEST = "";
