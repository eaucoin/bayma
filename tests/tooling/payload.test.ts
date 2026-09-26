import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNTIME_IDS, readPayloadManifest } from "@bayma/core";
import { packageManifest } from "../../tooling/src/build.ts";
import {
  PLATFORMS,
  PLATFORM_IDS,
  hostPlatformId,
} from "../../tooling/src/platforms.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const payloadDir = join(repoRoot, "dist", "payload");

test("the platform pins an archive and a digest for each toolchain", () => {
  expect([...PLATFORM_IDS]).toEqual(["linux-x64"]);
  const pins = PLATFORMS["linux-x64"];
  const archives = [
    pins.bun,
    pins.python,
    pins.dotnet,
    ...Object.values(pins.rustComponents),
    pins.uv,
    pins.zig,
    pins.llvm,
    pins.lean,
    pins.go,
    ...pins.clangSysroot.cells,
    ...pins.clangSysroot.build,
  ];
  for (const archive of archives) {
    expect(archive.url).toStartWith("https://");
    expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
  // The native hosts are held to a glibc floor, with a sysroot at it.
  expect(pins.glibcFloor).toBe("2.35");
});

test.if(existsSync(join(payloadDir, "payload.json")))(
  "the assembled payload describes every runtime and its pins",
  () => {
    const manifest = readPayloadManifest(payloadDir);
    expect(manifest.platform).toBe(hostPlatformId());
    expect(manifest.version).toBe(packageManifest(repoRoot).version);
    expect(Object.keys(manifest.runtimes).sort()).toEqual(
      [...RUNTIME_IDS].sort(),
    );
    for (const runtimeId of RUNTIME_IDS) {
      const runtime = manifest.runtimes[runtimeId];
      expect(existsSync(join(payloadDir, runtime.root))).toBe(true);
      expect(Object.keys(runtime.pins).length).toBeGreaterThan(0);
    }
    // Each runtime has its own directory, except C and C++, which share
    // their host.
    expect(
      RUNTIME_IDS.map((runtimeId) => manifest.runtimes[runtimeId].root),
    ).toEqual([
      "bun",
      "python",
      "dotnet-script",
      "rust",
      "clang",
      "clang",
      "lean",
      "go",
    ]);
  },
);

test.if(existsSync(join(payloadDir, "payload.json")))(
  "anyone may read the assembled payload and run its programs",
  () => {
    // bayma's image runs as whoever starts it.
    const closed = readdirSync(payloadDir, {
      recursive: true,
      encoding: "utf8",
    })
      .map((path) => ({ path, entry: lstatSync(join(payloadDir, path)) }))
      .filter(({ entry }) => {
        if (entry.isSymbolicLink()) return false;
        const usable =
          entry.isDirectory() || entry.mode & 0o100 ? 0o555 : 0o444;
        return (entry.mode & usable) !== usable;
      })
      .map(({ path }) => path);
    expect(closed).toEqual([]);
  },
);
