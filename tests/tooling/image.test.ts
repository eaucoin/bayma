import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  buildImage,
  imageBuildCommand,
  imageTags,
} from "../../tooling/src/image.ts";
import { withTempDir } from "../support/temp.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");

test("the image is tagged locally and for its registry at one version", () => {
  expect(imageTags("1.2.3")).toEqual([
    "bayma:1.2.3",
    "ghcr.io/eaucoin/bayma:1.2.3",
  ]);
});

test("the image is built from the repository's Dockerfile and context", () => {
  expect(imageBuildCommand("/repo", imageTags("1.2.3"))).toEqual([
    "docker",
    "build",
    "--platform",
    "linux/amd64",
    "--file",
    join("/repo", "Dockerfile"),
    "--tag",
    "bayma:1.2.3",
    "--tag",
    "ghcr.io/eaucoin/bayma:1.2.3",
    "/repo",
  ]);
});

test("an image is not built without the bundle it carries", async () => {
  await withTempDir(async (dist) => {
    await expect(buildImage(repoRoot, dist)).rejects.toThrow(
      "run `bun run build` first",
    );
  });
});
