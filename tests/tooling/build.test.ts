import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { packageManifest } from "../../tooling/src/build.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");

test("the server's manifest is packages/server and carries the version", () => {
  const manifest = packageManifest(repoRoot);
  expect(manifest.name).toBe("@bayma/server");
  expect(manifest.private).toBe(true);
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
});
