import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  compareVersionPrecedence,
  isValidVersion,
  resolveDotnetScriptLibraryDirFromToolsRoot,
} from "@bayma/runtime-dotnet-script";

const temporaryRoots = new Set<string>();

function makeToolsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bayma-dotnet-script-tools-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  temporaryRoots.clear();
});

test("dotnet version precedence accepts only complete semantic versions", () => {
  expect(isValidVersion("8.0.10-preview.2+build.7")).toBe(true);
  expect(isValidVersion("8.0.not-a-version")).toBe(false);
  expect(isValidVersion("8.0.10+")).toBe(false);
  expect(isValidVersion("8.0.10+bad+build")).toBe(false);
  expect(compareVersionPrecedence("8.0.10", "8.0.9")).toBeGreaterThan(0);
});

function makeLibraryDir(root: string, tfm: string, version = "2.0.0"): string {
  const dir = join(
    root,
    ".store",
    "dotnet-script",
    version,
    "dotnet-script",
    version,
    "tools",
    tfm,
    "any",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Dotnet.Script.Core.dll"), "");
  return dir;
}

test("resolveDotnetScriptLibraryDirFromToolsRoot honors the apphost dll path", () => {
  const toolsRoot = makeToolsRoot();
  const olderTfmDir = makeLibraryDir(toolsRoot, "net8.0");
  const embeddedTfmDir = makeLibraryDir(toolsRoot, "net10.0");
  const executableName =
    process.platform === "win32" ? "dotnet-script.exe" : "dotnet-script";

  writeFileSync(
    join(toolsRoot, executableName),
    [
      "stub",
      ".store/dotnet-script/2.0.0/dotnet-script/2.0.0/tools/net10.0/any/dotnet-script.dll",
      "stub",
    ].join("\0"),
    "latin1",
  );

  expect(olderTfmDir).not.toBe(embeddedTfmDir);
  expect(resolveDotnetScriptLibraryDirFromToolsRoot(toolsRoot)).toBe(
    embeddedTfmDir,
  );
});

test("resolveDotnetScriptLibraryDirFromToolsRoot falls back to the highest available tfm", () => {
  const toolsRoot = makeToolsRoot();
  makeLibraryDir(toolsRoot, "net8.0");
  const latestTfmDir = makeLibraryDir(toolsRoot, "net9.0");

  expect(resolveDotnetScriptLibraryDirFromToolsRoot(toolsRoot)).toBe(
    latestTfmDir,
  );
});

test("resolveDotnetScriptLibraryDirFromToolsRoot uses semantic stable version precedence", () => {
  const toolsRoot = makeToolsRoot();
  makeLibraryDir(toolsRoot, "net10.0", "2.0.9");
  makeLibraryDir(toolsRoot, "net10.0", "2.0.10-preview.1");
  const latestStableDir = makeLibraryDir(toolsRoot, "net10.0", "2.0.10");
  makeLibraryDir(toolsRoot, "net99.0", "99.0.not-a-version");
  mkdirSync(join(toolsRoot, ".store", "dotnet-script", "99.0.0"), {
    recursive: true,
  });
  writeFileSync(join(toolsRoot, ".store", "dotnet-script", "100.0.0"), "");

  expect(resolveDotnetScriptLibraryDirFromToolsRoot(toolsRoot)).toBe(
    latestStableDir,
  );
});

test("resolveDotnetScriptLibraryDirFromToolsRoot rejects an embedded path escape", () => {
  const toolsRoot = makeToolsRoot();
  const outsideRoot = makeToolsRoot();
  const fallbackDir = makeLibraryDir(toolsRoot, "net10.0");
  const escapedDir = join(outsideRoot, "tools", "net10.0", "any");
  mkdirSync(escapedDir, { recursive: true });
  writeFileSync(join(escapedDir, "Dotnet.Script.Core.dll"), "");
  const executableName =
    process.platform === "win32" ? "dotnet-script.exe" : "dotnet-script";
  writeFileSync(
    join(toolsRoot, executableName),
    `.store/dotnet-script/../../../${basename(outsideRoot)}/tools/net10.0/any/dotnet-script.dll`,
    "latin1",
  );

  expect(resolveDotnetScriptLibraryDirFromToolsRoot(toolsRoot)).toBe(
    fallbackDir,
  );
});
