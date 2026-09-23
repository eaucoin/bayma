import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, expect, test } from "bun:test";

import { openToolbelt, type Toolbelt } from "./toolbelt.ts";

const TOOLBELT_ROOT = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
let toolbelt: Toolbelt;

beforeAll(async () => {
  ({ toolbelt } = await openToolbelt({ cwd: TOOLBELT_ROOT }));
});

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "bayma-toolbelt-stress-")),
  );
  roots.push(root);
  return root;
}

test("ts-morph renames a symbol across a generated 150-file project", () => {
  const project = new toolbelt.tsMorph.Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    "/src/shared.ts",
    "export function sharedValue(input: number): number {\n  return input * 2\n}\n",
  );
  for (let index = 0; index < 150; index += 1) {
    project.createSourceFile(
      `/src/module-${index}.ts`,
      `import { sharedValue } from './shared'\nexport const value${index}: number = sharedValue(${index})\n`,
    );
  }
  const shared = project
    .getSourceFileOrThrow("/src/shared.ts")
    .getFunctionOrThrow("sharedValue");
  expect(shared.findReferencesAsNodes()).toHaveLength(300);
  expect(shared.getReturnType().getText()).toBe("number");

  shared.rename("doubledValue");

  const renamed = project
    .getSourceFiles()
    .filter((file) => file.getFullText().includes("doubledValue"));
  expect(renamed).toHaveLength(151);
  expect(
    project
      .getSourceFiles()
      .some((file) => file.getFullText().includes("sharedValue")),
  ).toBe(false);
  expect(project.getPreEmitDiagnostics()).toHaveLength(0);
}, 60_000);

test("ast-grep parses, matches and rewrites TypeScript and Python in bulk", () => {
  const { napi } = toolbelt.astGrep;
  let rewritten = 0;
  for (let index = 0; index < 500; index += 1) {
    const root = napi
      .parse(
        napi.Lang.TypeScript,
        `const value${index} = compute(${index}, 'x')\n`,
      )
      .root();
    const call = root.find("compute($A, $B)");
    expect(call?.getMatch("A")?.text()).toBe(String(index));
    const edited = root.commitEdits([call!.replace(`computeFast(${index})`)]);
    if (edited.includes(`computeFast(${index})`)) rewritten += 1;
  }
  const python = napi.parse(
    "python",
    "class A:\n    def one(self): pass\n    def two(self): pass\n",
  );
  expect(
    python.root().findAll({ rule: { kind: "function_definition" } }),
  ).toHaveLength(2);
  expect(rewritten).toBe(500);
});

test("globby and ripgrep agree over 400 files with gitignore rules", async () => {
  const root = temporaryRoot();
  writeFileSync(join(root, ".gitignore"), "ignored/\n");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "ignored"));
  for (let index = 0; index < 400; index += 1) {
    const directory = index % 10 === 0 ? "ignored" : "src";
    writeFileSync(
      join(root, directory, `file-${index}.ts`),
      `export const marker${index} = 'needle-${index % 3}'\n`,
    );
  }
  await toolbelt.execa.execa("git", ["init", "-q"], { cwd: root });

  const listed = await toolbelt.globby.globby("**/*.ts", {
    cwd: root,
    gitignore: true,
  });
  const search = await toolbelt.execa.execa(toolbelt.ripgrep.rgPath, [
    "--files-with-matches",
    "needle-",
    root,
  ]);

  expect(listed).toHaveLength(360);
  expect(search.stdout.split("\n").filter(Boolean)).toHaveLength(360);
});

test("structured formats round-trip while keeping comments", () => {
  const yamlDocument = toolbelt.yaml.parseDocument(
    "# keep me\nanswer: 42\nlist: [1, 2]\n",
  );
  yamlDocument.set("answer", 43);
  expect(yamlDocument.toString()).toContain("# keep me");
  expect(yamlDocument.toString()).toContain("answer: 43");

  const jsoncText = '{\n  // keep me\n  "answer": 42\n}\n';
  const edits = toolbelt.jsonc.modify(jsoncText, ["answer"], 43, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const updated = toolbelt.jsonc.applyEdits(jsoncText, edits);
  expect(updated).toContain("// keep me");
  expect(toolbelt.jsonc.parse(updated).answer).toBe(43);

  const toml = toolbelt.toml.parse(
    '[package]\nname = "fixture"\nversion = "1.0.0"\n',
  );
  expect(toolbelt.toml.stringify(toml)).toContain('name = "fixture"');

  const xml = new toolbelt.xml.XMLParser({ ignoreAttributes: false }).parse(
    '<root><item id="1"/><item id="2"/></root>',
  );
  expect(xml.root.item).toHaveLength(2);
  expect(
    new toolbelt.xml.XMLBuilder({ ignoreAttributes: false }).build(xml),
  ).toContain('id="2"');

  const markdown = toolbelt.markdown.fromMarkdown(
    Array.from(
      { length: 200 },
      (_, index) => `# Heading ${index}\n\nBody ${index}\n`,
    ).join("\n"),
  );
  expect(
    markdown.children.filter((node) => node.type === "heading"),
  ).toHaveLength(200);
});

test("a generated patch applies cleanly and diffs report exact changes", () => {
  const before =
    Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n") +
    "\n";
  const after = before
    .replace("line 250\n", "line 250 changed\n")
    .replace("line 499\n", "line 499\nline 500\n");
  const patch = toolbelt.diff.createPatch("file.txt", before, after);
  expect(toolbelt.diff.applyPatch(before, patch)).toBe(after);
  const changes = toolbelt.diff
    .diffLines(before, after)
    .filter((part) => part.added || part.removed);
  expect(changes.reduce((count, part) => count + (part.count ?? 0), 0)).toBe(3);
});

test("200 concurrent atomic writes land intact under p-map", async () => {
  const root = temporaryRoot();
  const payloads = Array.from({ length: 200 }, (_, index) => ({
    index,
    body: `${index}:`.padEnd(4096, String(index % 10)),
  }));
  await toolbelt.pMap.default(
    payloads,
    ({ index, body }) =>
      toolbelt.writeFileAtomic.default(join(root, `out-${index}.txt`), body),
    { concurrency: 16 },
  );
  for (const { index, body } of payloads) {
    expect(readFileSync(join(root, `out-${index}.txt`), "utf8")).toBe(body);
  }
  const cache = new toolbelt.lruCache.LRUCache<number, string>({ max: 32 });
  for (const { index, body } of payloads) cache.set(index, body);
  expect(cache.size).toBe(32);
  expect(cache.has(0)).toBe(false);
  expect(cache.has(199)).toBe(true);
  expect(
    toolbelt.remeda.pipe(
      payloads,
      toolbelt.remeda.map((item) => item.index),
      toolbelt.remeda.sum(),
    ),
  ).toBe(19_900);
});

test("editorconfig and binary detection read real files", async () => {
  const root = temporaryRoot();
  writeFileSync(
    join(root, ".editorconfig"),
    "root = true\n\n[*.ts]\nindent_style = space\nindent_size = 2\n",
  );
  writeFileSync(join(root, "text.ts"), "export {}\n");
  writeFileSync(
    join(root, "binary.bin"),
    Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 256)),
  );
  const properties = await toolbelt.editorconfig.parse(join(root, "text.ts"));
  expect(properties.indent_size).toBe(2);
  expect(await toolbelt.isBinaryFile.isBinaryFile(join(root, "text.ts"))).toBe(
    false,
  );
  expect(
    await toolbelt.isBinaryFile.isBinaryFile(join(root, "binary.bin")),
  ).toBe(true);
});

test("simple-git drives a 30-commit history in a fresh repository", async () => {
  const root = temporaryRoot();
  const { toolbelt: bound, repoRoot } = await (async () => {
    await toolbelt.execa.execa("git", ["init", "-q"], { cwd: root });
    return openToolbelt({ cwd: root });
  })();
  expect(repoRoot).toBe(root);
  const git = bound.simpleGit!;
  await git
    .addConfig("user.name", "Toolbelt Test")
    .addConfig("user.email", "toolbelt@example.test");
  for (let index = 0; index < 30; index += 1) {
    writeFileSync(join(root, "history.txt"), `revision ${index}\n`);
    await git.add("history.txt");
    await git.commit(`revision ${index}`);
  }
  const log = await git.log();
  expect(log.total).toBe(30);
  expect(log.latest?.message).toBe("revision 29");
  const summary = await git.diffSummary(["HEAD~5", "HEAD"]);
  expect(summary.files.map((file) => file.file)).toEqual(["history.txt"]);
}, 60_000);

test("vitest.run executes a real project suite and reports each outcome", async () => {
  const root = temporaryRoot();
  symlinkSync(join(TOOLBELT_ROOT, "node_modules"), join(root, "node_modules"));
  writeFileSync(
    join(root, "package.json"),
    '{"name": "vitest-fixture", "type": "module"}\n',
  );
  writeFileSync(
    join(root, "math.test.ts"),
    [
      "import { expect, test } from 'vitest'",
      "test('adds', () => { expect(1 + 1).toBe(2) })",
      "test('fails', () => { expect(1 + 1).toBe(3) })",
      "test.skip('skipped', () => {})",
      "",
    ].join("\n"),
  );

  const run = await toolbelt.vitest.run("test", [], { root });

  expect(run.success).toBe(false);
  expect(run.report.numPassedTests).toBe(1);
  expect(run.report.numFailedTests).toBe(1);
  expect(run.report.numPendingTests).toBe(1);
}, 120_000);
