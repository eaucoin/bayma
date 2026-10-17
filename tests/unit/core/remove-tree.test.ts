import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { removeTree, removeTreeAsync } from "@bayma/core";
import { withTempDir } from "../../support/temp.ts";
import {
  AS_ROOT,
  goModuleCache,
  rootOwned,
} from "../../support/unremovable.ts";

test("a tree shaped as Go's module cache, its directories read-only, is removed whole, which rm -rf cannot", async () => {
  await withTempDir(async (dir) => {
    // As it is, nothing in it can be unlinked.
    const control = goModuleCache(join(dir, "control"));
    expect(() => rmSync(control, { recursive: true, force: true })).toThrow(
      expect.objectContaining({ code: "EACCES" }),
    );
    removeTree(control);

    const tree = goModuleCache(dir);
    expect(removeTree(tree)).toBeUndefined();
    expect(existsSync(tree)).toBe(false);
  });
});

test("a path that is not there is removed already", async () => {
  await withTempDir(async (dir) => {
    expect(removeTree(join(dir, "missing"))).toBeUndefined();
  });
});

test.skipIf(!AS_ROOT)(
  "a tree root owns is left, its error returned, never thrown",
  async () => {
    await withTempDir(async (dir) => {
      const locked = join(dir, "locked");
      const unlock = rootOwned(locked);
      try {
        const failure = removeTree(locked);
        expect(failure).toEqual(expect.objectContaining({ code: "EACCES" }));
        expect(existsSync(join(locked, "a", "b"))).toBe(true);
      } finally {
        unlock();
      }
    });
  },
);

test("off the event loop, a tree shaped as Go's module cache is removed whole too", async () => {
  await withTempDir(async (dir) => {
    const tree = goModuleCache(dir);
    expect(await removeTreeAsync(tree)).toBeUndefined();
    expect(existsSync(tree)).toBe(false);
    expect(await removeTreeAsync(join(dir, "missing"))).toBeUndefined();
  });
});

test.skipIf(!AS_ROOT)(
  "off the event loop, a tree root owns is left, its error returned, never thrown",
  async () => {
    await withTempDir(async (dir) => {
      const locked = join(dir, "locked");
      const unlock = rootOwned(locked);
      try {
        expect(await removeTreeAsync(locked)).toEqual(
          expect.objectContaining({ code: "EACCES" }),
        );
        expect(existsSync(join(locked, "a", "b"))).toBe(true);
      } finally {
        unlock();
      }
    });
  },
);
