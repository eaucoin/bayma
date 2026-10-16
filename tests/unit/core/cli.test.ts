import { expect, test } from "bun:test";
import {
  hostPlatformId,
  parseCliOptions,
  parseRuntimeMemoryBudget,
  PLATFORM_IDS,
} from "@bayma/core";

test("runtime CLI options are command scoped and unambiguous", () => {
  expect(
    Object.fromEntries(
      parseCliOptions(
        ["--port", "7290", "--path", "/mcp"],
        ["--port", "--path"],
      ),
    ),
  ).toEqual({ "--port": "7290", "--path": "/mcp" });

  expect(() => parseCliOptions(["--host", "localhost"], ["--port"])).toThrow(
    "unknown option --host",
  );
  expect(() =>
    parseCliOptions(["--port", "7290", "--port", "7291"], ["--port"]),
  ).toThrow("option --port may be provided only once");
  expect(() =>
    parseCliOptions(["--port", "--path", "/mcp"], ["--port", "--path"]),
  ).toThrow("option --port requires one value");
});

test("the platform id names the payload bayma needs", () => {
  expect([...PLATFORM_IDS]).toEqual(["linux-x64"]);
  expect(hostPlatformId("linux", "x64")).toBe("linux-x64");
  expect(() => hostPlatformId("darwin", "arm64")).toThrow(
    "bayma runs on linux-x64, not darwin-arm64",
  );
});

test("the runtime memory budget is a list of budgets in MiB, for the runtimes that keep each cell, for all, or for one", () => {
  const MIB = 1024 ** 2;
  expect(parseRuntimeMemoryBudget("2048")).toEqual({ keeping: 2048 * MIB });
  expect(parseRuntimeMemoryBudget("0")).toEqual({ keeping: 0 });
  expect(parseRuntimeMemoryBudget("1024, all=4096,python=8192,bun=0")).toEqual({
    keeping: 1024 * MIB,
    all: 4096 * MIB,
    runtimes: { python: 8192 * MIB, bun: 0 },
  });
  for (const spec of ["", "-1", "1.5", "python=", "=3", "cobol=1"])
    expect(() => parseRuntimeMemoryBudget(spec)).toThrow();
});
