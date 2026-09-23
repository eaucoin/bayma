import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { BUNDLE, packageManifest } from "../../tooling/src/build.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");

test("the published manifest is packages/server and names the product", () => {
  const manifest = packageManifest(repoRoot);
  expect(manifest.name).toBe("@bayma-repl/bayma");
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(manifest.bin).toEqual({ bayma: `dist/${BUNDLE}` });
});
