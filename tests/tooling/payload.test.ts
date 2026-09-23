import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNTIME_IDS, readPayloadManifest } from "@bayma/core";
import { packageManifest } from "../../tooling/src/build.ts";
import {
  PLATFORMS,
  PLATFORM_IDS,
  hostPlatformId,
} from "../../tooling/src/platforms.ts";
import { payloadTarballName } from "../../tooling/src/payload.ts";
import { withTempDir } from "../support/temp.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const payloadDir = join(repoRoot, "dist", "payload");

test("every platform pins an archive and a digest for each toolchain", () => {
  expect([...PLATFORM_IDS]).toEqual(["linux-x64", "darwin-arm64"]);
  for (const platform of PLATFORM_IDS) {
    const pins = PLATFORMS[platform];
    const archives = [
      pins.bun,
      pins.python,
      pins.dotnet,
      ...Object.values(pins.rustComponents),
      ...(pins.linker ? [pins.linker] : []),
    ];
    for (const archive of archives) {
      expect(archive.url).toStartWith("https://");
      expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  }
  // Only Linux pins a linker: macOS links the host with Apple's clang.
  expect(PLATFORMS["linux-x64"].linker).toBeDefined();
  expect(PLATFORMS["darwin-arm64"].linker).toBeUndefined();
});

test("the payload tarball is named for its platform and version", () => {
  const { version } = packageManifest(repoRoot);
  expect(payloadTarballName(hostPlatformId(), version)).toBe(
    `bayma-payload-${hostPlatformId()}-${version}.tar.gz`,
  );
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
      expect(runtime.root).toBe(runtimeId);
      expect(existsSync(join(payloadDir, runtime.root))).toBe(true);
      expect(Object.keys(runtime.pins).length).toBeGreaterThan(0);
    }
  },
);

test("staging a package without a release manifest is refused", async () => {
  await withTempDir(async (dir) => {
    const { stagePackage } = await import("../../tooling/src/publish.ts");
    if (existsSync(join(repoRoot, "dist", "payloads.json"))) {
      stagePackage(repoRoot, dir);
      expect(
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name,
      ).toBe("@bayma-repl/bayma");
      expect(existsSync(join(dir, "dist", "install.js"))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts,
      ).toEqual({ postinstall: "node dist/install.js" });
    } else {
      expect(() => stagePackage(repoRoot, dir)).toThrow("payloads.json");
    }
  });
});
