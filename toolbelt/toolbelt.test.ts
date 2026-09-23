import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import { simpleGit } from "simple-git";

import { openToolbelt } from "./toolbelt.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bayma-toolbelt-")));
  roots.push(root);
  return root;
}

function writeProjectVitestFixture(packageDir: string): void {
  const projectVitestDir = join(packageDir, "node_modules", "vitest");
  mkdirSync(projectVitestDir, { recursive: true });
  writeFileSync(
    join(projectVitestDir, "package.json"),
    `${JSON.stringify({
      name: "vitest",
      version: "0.0.0-project-fixture",
      type: "module",
      exports: { "./node": "./node.js" },
    })}\n`,
  );
  writeFileSync(
    join(projectVitestDir, "node.js"),
    [
      'import { writeFile } from "node:fs/promises"',
      "export async function startVitest(...args) {",
      "  await writeFile(args[2].outputFile, JSON.stringify({",
      '    fixture: { args, runtime: process.release.name, source: "project-local" },',
      "    numFailedTestSuites: 0,",
      "    numFailedTests: 0,",
      "    numPassedTestSuites: 1,",
      "    numPassedTests: 1,",
      "    numPendingTestSuites: 0,",
      "    numPendingTests: 0,",
      "    numTodoTests: 0,",
      "    numTotalTestSuites: 1,",
      "    numTotalTests: 1,",
      "    snapshot: {},",
      "    startTime: Date.now(),",
      "    success: true,",
      "    testResults: [],",
      "  }))",
      "  return { async close() {} }",
      "}",
      "",
    ].join("\n"),
  );
}

test("opens a repository-aware toolbelt from a nested checkout path", async () => {
  const repoRoot = temporaryRoot();
  const nested = join(repoRoot, "nested");
  mkdirSync(nested);
  await simpleGit({ baseDir: repoRoot }).init();
  writeFileSync(
    join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "fixture-root", private: true, workspaces: ["packages/*"] })}\n`,
  );
  writeFileSync(
    join(repoRoot, "package-lock.json"),
    '{"lockfileVersion": 3}\n',
  );
  const packageDir = join(repoRoot, "packages", "example");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@fixture/example", private: true })}\n`,
  );
  writeProjectVitestFixture(packageDir);

  const opened = await openToolbelt({ cwd: nested });
  const { toolbelt } = opened;
  expect(opened.repoRoot).toBe(repoRoot);
  expect((await toolbelt.simpleGit!.revparse(["--show-toplevel"])).trim()).toBe(
    repoRoot,
  );
  expect(Object.keys(toolbelt).sort()).toEqual([
    "astGrep",
    "diff",
    "editorconfig",
    "execa",
    "globby",
    "isBinaryFile",
    "jsonc",
    "lruCache",
    "manypkg",
    "markdown",
    "pMap",
    "remeda",
    "ripgrep",
    "simpleGit",
    "toml",
    "tsMorph",
    "vitest",
    "writeFileAtomic",
    "xml",
    "yaml",
  ]);
  const pythonRoot = toolbelt.astGrep.napi.parse(
    "python",
    "def greet(name):\n    return name\n",
  );
  expect(pythonRoot.root().kind()).toBe("module");
  expect(
    pythonRoot.root().findAll({
      rule: { kind: "function_definition" },
    }),
  ).toHaveLength(1);
  const packages = await toolbelt.manypkg.getPackages(repoRoot);
  expect(packages.rootDir).toBe(repoRoot);
  expect(packages.packages.map((pkg) => pkg.packageJson.name)).toEqual([
    "@fixture/example",
  ]);
  const projectVitest = await toolbelt.vitest.run("test", ["focused.test.ts"], {
    root: packageDir,
  });
  const fixture = (
    projectVitest.report as typeof projectVitest.report & {
      fixture: { args: unknown[]; runtime: string; source: string };
    }
  ).fixture;
  expect(projectVitest.success).toBe(true);
  expect(fixture.source).toBe("project-local");
  expect(fixture.runtime).toBe("node");
  expect(fixture.args[1]).toEqual(["focused.test.ts"]);
  expect(typeof toolbelt.diff.diffLines).toBe("function");
  expect(typeof toolbelt.editorconfig.parse).toBe("function");
  expect(typeof toolbelt.execa.execa).toBe("function");
  expect(typeof toolbelt.xml.XMLParser).toBe("function");
  expect(typeof toolbelt.globby.globby).toBe("function");
  expect(typeof toolbelt.isBinaryFile.isBinaryFile).toBe("function");
  expect(typeof toolbelt.jsonc.parse).toBe("function");
  expect(typeof toolbelt.lruCache.LRUCache).toBe("function");
  expect(typeof toolbelt.markdown.fromMarkdown).toBe("function");
  expect(typeof toolbelt.pMap.default).toBe("function");
  expect(typeof toolbelt.remeda.pipe).toBe("function");
  expect(typeof toolbelt.toml.parse).toBe("function");
  expect(typeof toolbelt.tsMorph.Project).toBe("function");
  expect("startVitest" in toolbelt.vitest).toBe(false);
  expect(typeof toolbelt.writeFileAtomic.default).toBe("function");
  expect(typeof toolbelt.yaml.parse).toBe("function");
  accessSync(toolbelt.ripgrep.rgPath, constants.X_OK);
}, 30_000);

test("opens outside a Git repository without the repository-bound client", async () => {
  const directory = temporaryRoot();
  writeProjectVitestFixture(directory);

  const opened = await openToolbelt({ cwd: directory });

  expect(opened.repoRoot).toBeNull();
  expect("simpleGit" in opened.toolbelt).toBe(false);
  const run = await opened.toolbelt.vitest.run("test", []);
  expect(run.success).toBe(true);
}, 30_000);
