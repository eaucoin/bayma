import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TOOLBELT_DIR } from "@bayma/core";
import { BUNDLE, packageManifest } from "../../tooling/src/build.ts";
import {
  buildImage,
  imageBuildCommand,
  imageTags,
  payloadLayers,
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

test("the image carries each of the payload's directories as a layer", () => {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  expect(payloadLayers(dockerfile)).toEqual([
    "bun",
    "python",
    "dotnet-script",
    "rust",
    "clang",
    "lean",
    "go",
    TOOLBELT_DIR,
    "payload.json",
  ]);
  expect(() =>
    payloadLayers("COPY dist/payload/bun /opt/bayma/payload/python\n"),
  ).toThrow("copies bun to python");
});

test("an image is not built from a payload the Dockerfile does not copy whole", async () => {
  const { version } = packageManifest(repoRoot);
  await withTempDir(async (dist) => {
    writeFileSync(
      join(dist, BUNDLE),
      `console.log(${JSON.stringify(version)});\n`,
    );
    const payload = join(dist, "payload");
    mkdirSync(join(payload, "bun"), { recursive: true });
    mkdirSync(join(payload, "zig"));
    writeFileSync(join(payload, "payload.json"), JSON.stringify({ version }));
    await expect(buildImage(repoRoot, dist)).rejects.toThrow(
      "the Dockerfile copies bun, clang, dotnet-script, go, lean, payload.json, python, rust, toolbelt of the payload, which holds bun, payload.json, zig",
    );
  });
});

test("an image is not built without the bundle it carries", async () => {
  await withTempDir(async (dist) => {
    await expect(buildImage(repoRoot, dist)).rejects.toThrow(
      "run `bun run build` first",
    );
  });
});
