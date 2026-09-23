import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { ensureRuntimeAssetInDirectory } from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

test("runtime assets are atomic and content addressed", async () => {
  await withTempDir(async (dir) => {
    const first = ensureRuntimeAssetInDirectory(
      dir,
      "runtime-harness.txt",
      "canonical harness\n",
    );
    const second = ensureRuntimeAssetInDirectory(
      dir,
      "runtime-harness.txt",
      "canonical harness\n",
    );

    expect(second).toBe(first);
    expect(readFileSync(first, "utf8")).toBe("canonical harness\n");
    expect(first).toMatch(/[0-9a-f]{24}-runtime-harness\.txt$/);
    expect(() =>
      ensureRuntimeAssetInDirectory(dir, "../escape.txt", "escape"),
    ).toThrow("runtime asset filename must be one basename");

    writeFileSync(first, "corrupt", "utf8");
    expect(() =>
      ensureRuntimeAssetInDirectory(
        dir,
        "runtime-harness.txt",
        "canonical harness\n",
      ),
    ).toThrow("runtime asset content does not match");
  });
});
