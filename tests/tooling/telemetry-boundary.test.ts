import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertBundleShipsOwnTelemetry } from "../../tooling/src/telemetry/boundary.ts";
import { withTempDir } from "../support/temp.ts";

// bayma ships its own telemetry and nothing of its development's, and loads
// the SDK only where telemetry is configured.

const repoRoot = resolve(import.meta.dir, "..", "..");

/** The repository's files under `paths`, committed or not, but not ignored. */
function repositoryFiles(...paths: string[]): string[] {
  return spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ...paths],
    { cwd: repoRoot },
  )
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
}

/** The modules a source file imports, statically or dynamically. */
function imports(path: string): { specifier: string; dynamic: boolean }[] {
  const source = readFileSync(join(repoRoot, path), "utf8");
  return [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
  ]
    .map((match) => ({ specifier: match[1]!, dynamic: false }))
    .concat(
      [...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(
        (match) => ({ specifier: match[1]!, dynamic: true }),
      ),
    );
}

test("no package bayma ships depends on the tooling", () => {
  for (const manifest of repositoryFiles("packages/*/package.json")) {
    const { dependencies, devDependencies, peerDependencies } = JSON.parse(
      readFileSync(join(repoRoot, manifest), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    for (const name of Object.keys({
      ...dependencies,
      ...devDependencies,
      ...peerDependencies,
    }))
      expect(`${manifest}: ${name}`).not.toMatch(/: @bayma\/tooling$/);
  }
  for (const source of repositoryFiles("packages").filter((path) =>
    /\.(ts|js|mjs|cjs)$/.test(path),
  ))
    for (const { specifier } of imports(source))
      expect(`${source}: ${specifier}`).not.toMatch(/: .*\btooling\//);
});

test("only telemetry that is configured loads the SDK", () => {
  // Everything else records through OpenTelemetry's API, which records
  // nothing by itself; the SDK is sdk.ts's alone, and imported only when the
  // environment configures telemetry.
  const sdk = "packages/core/src/telemetry/sdk.ts";
  const api = new Set(["@opentelemetry/api", "@opentelemetry/api-logs"]);
  for (const source of repositoryFiles("packages", "tooling", "tests")) {
    if (!/\.ts$/.test(source)) continue;
    for (const { specifier, dynamic } of imports(source)) {
      if (specifier.startsWith("@opentelemetry/") && !api.has(specifier))
        expect(source).toBe(sdk);
      if (/(^|\/)sdk\.ts$/.test(specifier))
        expect({ source, dynamic }).toEqual({
          source: "packages/core/src/telemetry/index.ts",
          dynamic: true,
        });
    }
  }
});

test("a bundle with development tooling, the Node SDK, or gRPC in it is refused", () => {
  withTempDir((dir) => {
    const bundle = join(dir, "bundle.js");
    writeFileSync(
      bundle,
      "// node_modules/@opentelemetry/exporter-trace-otlp-proto/build/src/index.js\nexport {};\n",
    );
    expect(() => assertBundleShipsOwnTelemetry(bundle)).not.toThrow();
    for (const [module, what] of [
      ["tooling/src/telemetry/index.ts", "development tooling"],
      ["node_modules/@opentelemetry/sdk-node/build/src/sdk.js", "Node SDK"],
      ["node_modules/@grpc/grpc-js/build/src/index.js", "gRPC"],
    ]) {
      writeFileSync(bundle, `// ${module}\n`);
      expect(() => assertBundleShipsOwnTelemetry(bundle)).toThrow(what);
    }
  });
});
