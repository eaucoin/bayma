import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { TEST_ROOTS, testShards } from "../../tooling/src/test-shards.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");

/** The test files `bun test` runs for `filters`, which match by substring. */
function testFiles(filters: string[]): string[] {
  return readdirSync(join(repoRoot, "tests"), {
    recursive: true,
    encoding: "utf8",
  })
    .map((path) => join("tests", path))
    .filter(
      (path) =>
        /\.test\.ts$/.test(path) &&
        filters.some((filter) => path.includes(filter)),
    )
    .sort();
}

test("bun run test runs every test file under the test roots", async () => {
  const manifest = (await Bun.file(join(repoRoot, "package.json")).json()) as {
    scripts: Record<string, string>;
  };
  expect(manifest.scripts.test).toEndWith(` test ${TEST_ROOTS.join(" ")}`);
});

test("the test shards run every file bun run test runs, each once", () => {
  const shards = Object.values(testShards(repoRoot)).map(testFiles);
  for (const files of shards) expect(files.length).toBeGreaterThan(0);
  expect(shards.flat().sort()).toEqual(testFiles(TEST_ROOTS));
});
