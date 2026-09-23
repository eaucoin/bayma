import { expect, test } from "bun:test";
import { cacheRoot, defaultStateDir, stateRoot } from "@bayma/core";

const home = { HOME: "/home/someone" };

test("state and cache roots follow XDG with the conventional fallbacks", () => {
  expect(stateRoot(home)).toBe("/home/someone/.local/state/bayma");
  expect(cacheRoot(home)).toBe("/home/someone/.cache/bayma");
  expect(stateRoot({ ...home, XDG_STATE_HOME: "/xdg/state" })).toBe(
    "/xdg/state/bayma",
  );
  expect(cacheRoot({ ...home, XDG_CACHE_HOME: "/xdg/cache" })).toBe(
    "/xdg/cache/bayma",
  );
  expect(cacheRoot({ ...home, BAYMA_CACHE_DIR: "/elsewhere" })).toBe(
    "/elsewhere",
  );
});

test("the default state directory is keyed by the launch directory", () => {
  const first = defaultStateDir("/projects/one", home);
  const again = defaultStateDir("/projects/one/", home);
  const other = defaultStateDir("/projects/two", home);
  expect(first).toBe(again);
  expect(first).not.toBe(other);
  expect(first.startsWith("/home/someone/.local/state/bayma/")).toBe(true);
  expect(first.slice(first.lastIndexOf("/") + 1)).toMatch(/^[0-9a-f]{16}$/);
  expect(
    defaultStateDir("/projects/one", { ...home, BAYMA_STATE_DIR: "/s" }),
  ).toBe("/s");
});
