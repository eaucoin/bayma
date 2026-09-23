import { expect, test } from "bun:test";
import { hostPlatformId, parseCliOptions, PLATFORM_IDS } from "@bayma/core";

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
  expect([...PLATFORM_IDS]).toEqual(["linux-x64", "darwin-arm64"]);
  expect(hostPlatformId("linux", "x64")).toBe("linux-x64");
  expect(hostPlatformId("darwin", "arm64")).toBe("darwin-arm64");
  expect(() => hostPlatformId("win32", "x64")).toThrow(
    "bayma runs on linux-x64 and darwin-arm64, not win32-x64",
  );
});
