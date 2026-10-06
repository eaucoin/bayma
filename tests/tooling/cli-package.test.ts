import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildCli,
  bundleImports,
  CLI_BUNDLE,
  CLI_PACKAGE_DIR,
  cliManifest,
} from "../../tooling/src/cli-package.ts";
import { IMAGE_REPOSITORIES } from "../../tooling/src/image.ts";
import { RELEASE_MODULE, releaseModule } from "../../tooling/src/release.ts";
import { runOrThrow } from "../../tooling/src/shared/process.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");

test("the bayma command is published as `bayma-repl`, at the server's version, with no dependencies", () => {
  const manifest = cliManifest(repoRoot);
  expect(manifest.name).toBe("bayma-repl");
  expect(manifest.private).toBeUndefined();
  expect(manifest.bin).toEqual({ bayma: "dist/bayma.js" });
  expect(join(CLI_PACKAGE_DIR, "dist", "bayma.js")).toBe(CLI_BUNDLE);
  expect(manifest.dependencies).toBeUndefined();
});

test("between releases the command pins no image, as the release module's template says", () => {
  expect(readFileSync(join(repoRoot, RELEASE_MODULE), "utf8")).toBe(
    releaseModule(""),
  );
  expect(releaseModule("")).toContain(
    `IMAGE_REPOSITORY = "${IMAGE_REPOSITORIES[1]}"`,
  );
});

test("a release pins the command to a sha256 digest, and nothing else", () => {
  const digest = `sha256:${"0a".repeat(32)}`;
  expect(releaseModule(digest)).toContain(`IMAGE_DIGEST = "${digest}";`);
  expect(() => releaseModule("latest")).toThrow(
    "latest is not a sha256 digest",
  );
  expect(() => releaseModule("sha256:1234")).toThrow("is not a sha256 digest");
});

test("a bundle's imports are read, static and dynamic", () => {
  expect(
    bundleImports(
      'import { a } from "node:fs";\nimport * as b from"node:os";\nimport "side";\nconst c = await import("pkg");\nrequire("other");',
    ),
  ).toEqual(["node:fs", "node:os", "side", "pkg", "other"]);
});

test("the package npm packs holds the bundle and its manifest alone", async () => {
  await buildCli(repoRoot);
  const { stdout } = await runOrThrow(["npm", "pack", "--dry-run", "--json"], {
    cwd: join(repoRoot, CLI_PACKAGE_DIR),
  });
  const [report] = JSON.parse(stdout) as { files: { path: string }[] }[];
  expect(report!.files.map(({ path }) => path).sort()).toEqual([
    "dist/bayma.js",
    "package.json",
  ]);
}, 60_000);
