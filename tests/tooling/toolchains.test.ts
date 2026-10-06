import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  provisioningModules,
  staleVersions,
  TOOLCHAINS,
  toolchainImage,
  toolchainTag,
} from "../../tooling/src/toolchains.ts";
import { withTempDir } from "../support/temp.ts";

const tooling = resolve(import.meta.dir, "..", "..", "tooling", "src");

function toolchain(name: string) {
  const found = TOOLCHAINS.find((toolchain) => toolchain.name === name);
  if (!found) throw new Error(`no toolchain ${name}`);
  return found;
}

/** A repository holding one file of each kind toolchains are built from. */
function writeSources(repoRoot: string): void {
  const files = [
    "packages/runtime-rust/native/Cargo.lock",
    "packages/runtime-rust/native/bayma-rust-host/src/main.rs",
    "packages/runtime-rust/native/evcxr/src/lib.rs",
    "packages/runtime-rust/native/bayma-rust-support/src/lib.rs",
    "packages/runtime-cpp/native/src/host.cpp",
    "packages/runtime-lean/native/BaymaLeanHost.lean",
    "packages/runtime-lean/native/lakefile.toml",
    "packages/runtime-lean/native/lean-toolchain",
    "packages/runtime-go/native/main.go",
    "skills/bayma-runtime-python/SKILL.md",
    "toolbelt/Cargo.lock",
    "toolbelt/toolbelt.ts",
  ];
  for (const file of files) {
    mkdirSync(join(repoRoot, dirname(file)), { recursive: true });
    writeFileSync(join(repoRoot, file), `${file}\n`);
  }
}

function tags(repoRoot: string): Record<string, string> {
  return Object.fromEntries(
    TOOLCHAINS.map((toolchain) => [
      toolchain.name,
      toolchainTag(repoRoot, toolchain),
    ]),
  );
}

/** The toolchains whose tags `change` to the repository changes. */
function retagged(change: (repoRoot: string) => void): Promise<string[]> {
  return withTempDir((repoRoot) => {
    writeSources(repoRoot);
    const before = tags(repoRoot);
    change(repoRoot);
    const after = tags(repoRoot);
    return TOOLCHAINS.map((toolchain) => toolchain.name).filter(
      (name) => before[name] !== after[name],
    );
  }) as Promise<string[]>;
}

test("there is a toolchain for each provisioner, and the toolbelt", () => {
  expect(TOOLCHAINS.map((toolchain) => toolchain.name)).toEqual([
    "bun",
    "python",
    "dotnet-script",
    "rust",
    "clang",
    "lean",
    "go",
    "toolbelt",
  ]);
});

test("a toolchain's image is named for it and tagged with its digest", () => {
  withTempDir((repoRoot) => {
    writeSources(repoRoot);
    expect(toolchainImage(repoRoot, toolchain("go"))).toMatch(
      /^ghcr\.io\/eaucoin\/bayma-toolchains\/go:[0-9a-f]{64}$/,
    );
  });
});

test("a toolchain is retagged when what it is built from changes, and only then", async () => {
  const change = (file: string) => (repoRoot: string) =>
    appendFileSync(join(repoRoot, file), "changed\n");
  expect(await retagged(() => undefined)).toEqual([]);
  expect(await retagged(change("packages/runtime-go/native/main.go"))).toEqual([
    "go",
  ]);
  expect(
    await retagged(change("packages/runtime-cpp/native/src/host.cpp")),
  ).toEqual(["clang"]);
  expect(
    await retagged(change("packages/runtime-lean/native/lakefile.toml")),
  ).toEqual(["lean"]);
  expect(
    await retagged(
      change("packages/runtime-rust/native/bayma-rust-support/src/lib.rs"),
    ),
  ).toEqual(["rust"]);
  // The Cargo seed carries the toolbelt's locked crates.
  expect(await retagged(change("toolbelt/Cargo.lock"))).toEqual([
    "rust",
    "toolbelt",
  ]);
  expect(await retagged(change("toolbelt/toolbelt.ts"))).toEqual(["toolbelt"]);
  expect(
    await retagged(change("skills/bayma-runtime-python/SKILL.md")),
  ).toEqual(["toolbelt"]);
});

test("a toolchain's provisioning modules are those its provisioner runs", () => {
  const modules = (name: string) =>
    provisioningModules(toolchain(name).module).map((path) =>
      relative(tooling, path),
    );
  const go = modules("go");
  expect(go).toContain("provision/go.ts");
  expect(go).toContain("provision/zig.ts");
  expect(go).toContain("provision/payload.ts");
  expect(go).toContain("shared/download.ts");
  expect(go).not.toContain("provision/rust.ts");
  // Pins reach a tag as the toolchain names them, and telemetry shapes
  // nothing provisioning makes.
  expect(go).not.toContain("platforms.ts");
  expect(go.filter((path) => path.startsWith("telemetry/"))).toEqual([]);
  expect(modules("rust")).toContain("rust-licenses.ts");
  expect(modules("bun")).not.toContain("provision/zig.ts");
});

test("the registry keeps the newest versions of an image", () => {
  const versions = [
    { id: 1, created_at: "2026-10-01T00:00:00Z" },
    { id: 3, created_at: "2026-10-03T00:00:00Z" },
    { id: 2, created_at: "2026-10-02T00:00:00Z" },
    { id: 4, created_at: "2026-10-04T00:00:00Z" },
  ];
  expect(staleVersions(versions, 2).map((version) => version.id)).toEqual([
    2, 1,
  ]);
  expect(staleVersions(versions, 5)).toEqual([]);
});
