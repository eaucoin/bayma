import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertBundleUntraced,
  assertTreeUntraced,
} from "../../tooling/src/telemetry/boundary.ts";
import { withTempDir } from "../support/temp.ts";

// Development telemetry never reaches what bayma publishes, and costs nothing
// where it is not configured.

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

test("no package bayma publishes depends on OpenTelemetry or the tooling", () => {
  for (const manifest of repositoryFiles("packages/*/package.json")) {
    const { dependencies, devDependencies, peerDependencies } = JSON.parse(
      readFileSync(join(repoRoot, manifest), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    for (const name of Object.keys({
      ...dependencies,
      ...devDependencies,
      ...peerDependencies,
    }))
      expect(`${manifest}: ${name}`).not.toMatch(
        /: (@opentelemetry\/|@bayma\/tooling$)/,
      );
  }
  for (const source of repositoryFiles("packages").filter((path) =>
    /\.(ts|js|mjs|cjs)$/.test(path),
  ))
    for (const { specifier } of imports(source))
      expect(`${source}: ${specifier}`).not.toMatch(
        /: (@opentelemetry\/|.*\btooling\/)/,
      );
});

test("only an SDK that is configured is loaded", () => {
  // The API records nothing by itself; the SDK is sdk.ts's alone, and
  // imported only when the environment configures telemetry.
  const api = new Set(["@opentelemetry/api", "@opentelemetry/api-logs"]);
  for (const source of repositoryFiles("tooling", "tests")) {
    if (!/\.ts$/.test(source)) continue;
    for (const { specifier, dynamic } of imports(source)) {
      if (specifier.startsWith("@opentelemetry/") && !api.has(specifier))
        expect(source).toBe("tooling/src/telemetry/sdk.ts");
      if (/(^|\/)sdk\.ts$/.test(specifier))
        expect({ source, dynamic }).toEqual({
          source: "tooling/src/telemetry/index.ts",
          dynamic: true,
        });
    }
  }
});

test("a bundle or tree with OpenTelemetry in it is refused", () => {
  withTempDir((dir) => {
    const bundle = join(dir, "bundle.js");
    writeFileSync(bundle, "// node_modules/zod/index.js\nexport {};\n");
    expect(() => assertBundleUntraced(bundle)).not.toThrow();
    writeFileSync(bundle, "// node_modules/@opentelemetry/api/index.js\n");
    expect(() => assertBundleUntraced(bundle)).toThrow("OpenTelemetry");

    const tree = join(dir, "payload");
    mkdirSync(join(tree, "toolbelt", "node_modules", "zod"), {
      recursive: true,
    });
    writeFileSync(
      join(tree, "toolbelt", "node_modules", "zod", "index.js"),
      "",
    );
    expect(() => assertTreeUntraced(tree)).not.toThrow();
    const otel = join(
      tree,
      "toolbelt",
      "node_modules",
      "@opentelemetry",
      "api",
    );
    mkdirSync(otel, { recursive: true });
    writeFileSync(join(otel, "index.js"), "");
    expect(() => assertTreeUntraced(tree)).toThrow("OpenTelemetry");
  });
});
