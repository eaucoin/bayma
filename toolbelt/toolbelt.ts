import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { simpleGit, type SimpleGit } from "simple-git";
import type { JsonTestResults } from "vitest/reporters";

type VitestModule = typeof import("vitest/node");
type VitestStartArguments = Parameters<VitestModule["startVitest"]>;

export interface ToolbeltVitestRun {
  readonly exitCode: number;
  readonly report: JsonTestResults;
  readonly stderr: string;
  readonly stdout: string;
  readonly success: boolean;
}

export interface ToolbeltVitest extends Omit<VitestModule, "startVitest"> {
  readonly run: (...args: VitestStartArguments) => Promise<ToolbeltVitestRun>;
}

export interface OpenedToolbelt {
  /** The Git repository containing the working directory, or null outside one. */
  readonly repoRoot: string | null;
  readonly toolbelt: Toolbelt;
}

export interface Toolbelt extends ToolbeltPackages {
  readonly vitest: ToolbeltVitest;
  /** A simple-git client bound to `repoRoot`; absent outside a repository. */
  readonly simpleGit?: SimpleGit;
}

interface ToolbeltPackages {
  readonly astGrep: {
    readonly napi: typeof import("@ast-grep/napi");
    readonly python: typeof import("@ast-grep/lang-python");
  };
  readonly manypkg: typeof import("@manypkg/get-packages");
  readonly ripgrep: typeof import("@vscode/ripgrep");
  readonly diff: typeof import("diff");
  readonly editorconfig: typeof import("editorconfig");
  readonly execa: typeof import("execa");
  readonly xml: typeof import("fast-xml-parser");
  readonly globby: typeof import("globby");
  readonly isBinaryFile: typeof import("isbinaryfile");
  readonly jsonc: typeof import("jsonc-parser");
  readonly lruCache: typeof import("lru-cache");
  readonly markdown: typeof import("mdast-util-from-markdown");
  readonly pMap: typeof import("p-map");
  readonly remeda: typeof import("remeda");
  readonly toml: typeof import("smol-toml");
  readonly tsMorph: typeof import("ts-morph");
  readonly writeFileAtomic: typeof import("write-file-atomic");
  readonly yaml: typeof import("yaml");
}

interface ToolbeltModules extends ToolbeltPackages {
  readonly vitest: VitestModule;
}

let modulesPromise: Promise<ToolbeltModules> | undefined;

function serializeVitestRequest(input: unknown): string {
  return JSON.stringify(input, (_key, value: unknown) => {
    if (
      typeof value === "function" ||
      typeof value === "symbol" ||
      typeof value === "bigint"
    ) {
      throw new TypeError(
        "toolbelt.vitest.run accepts serializable options; put plugins and " +
          "other executable configuration in the project Vitest config file.",
      );
    }
    return value;
  });
}

/**
 * Vitest cannot start under Bun's entry point, so `run` starts it in Node
 * from the project's own Vitest install and returns its JSON report.
 */
function createProjectAwareVitest(
  vitest: VitestModule,
  execa: typeof import("execa"),
  defaultRoot: string,
): ToolbeltVitest {
  const runnerPath = fileURLToPath(
    new URL("./vitest-node-runner.mjs", import.meta.url),
  );
  const { startVitest: _unsafeBunEntryPoint, ...vitestExports } = vitest;
  const run: ToolbeltVitest["run"] = async (...args) => {
    const [
      mode = "test",
      filters = [],
      options = {},
      viteOverrides,
      vitestOptions,
    ] = args;
    const requestedRoot = resolve(defaultRoot, options.root ?? defaultRoot);
    const outputDirectory = await mkdtemp(join(tmpdir(), "toolbelt-vitest-"));
    const outputFile = join(outputDirectory, "report.json");
    try {
      const execution = await execa.execa("node", [runnerPath], {
        all: true,
        cwd: requestedRoot,
        input: serializeVitestRequest({
          filters,
          mode,
          options: {
            ...options,
            root: requestedRoot,
          },
          outputFile,
          viteOverrides,
          vitestOptions,
        }),
        reject: false,
      });
      let report: JsonTestResults;
      try {
        report = JSON.parse(
          await readFile(outputFile, "utf8"),
        ) as JsonTestResults;
      } catch (error) {
        throw new Error(
          `Vitest did not produce its JSON report (exit ${execution.exitCode}).` +
            `\n${execution.all ?? execution.stderr}`,
          { cause: error },
        );
      }
      return {
        exitCode: execution.exitCode ?? 1,
        report,
        stderr: execution.stderr,
        stdout: execution.stdout,
        success: execution.exitCode === 0 && report.success,
      };
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  };
  return Object.freeze({ ...vitestExports, run });
}

function loadModules(): Promise<ToolbeltModules> {
  modulesPromise ??= Promise.all([
    import("@ast-grep/napi"),
    import("@ast-grep/lang-python"),
    import("@manypkg/get-packages"),
    import("@vscode/ripgrep"),
    import("diff"),
    import("editorconfig"),
    import("execa"),
    import("fast-xml-parser"),
    import("globby"),
    import("isbinaryfile"),
    import("jsonc-parser"),
    import("lru-cache"),
    import("mdast-util-from-markdown"),
    import("p-map"),
    import("remeda"),
    import("smol-toml"),
    import("ts-morph"),
    import("vitest/node"),
    import("write-file-atomic"),
    import("yaml"),
  ]).then(
    ([
      astGrepNapi,
      astGrepPython,
      manypkg,
      ripgrep,
      diff,
      editorconfig,
      execa,
      xml,
      globby,
      isBinaryFile,
      jsonc,
      lruCache,
      markdown,
      pMap,
      remeda,
      toml,
      tsMorph,
      vitest,
      writeFileAtomic,
      yaml,
    ]) => {
      astGrepNapi.registerDynamicLanguage({ python: astGrepPython.default });
      return Object.freeze({
        astGrep: Object.freeze({ napi: astGrepNapi, python: astGrepPython }),
        manypkg,
        ripgrep,
        diff,
        editorconfig,
        execa,
        xml,
        globby,
        isBinaryFile,
        jsonc,
        lruCache,
        markdown,
        pMap,
        remeda,
        toml,
        tsMorph,
        vitest,
        writeFileAtomic,
        yaml,
      });
    },
  );
  return modulesPromise;
}

async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    return (
      await simpleGit({ baseDir: cwd }).revparse(["--show-toplevel"])
    ).trim();
  } catch {
    return null;
  }
}

export async function openToolbelt(
  input: { readonly cwd?: string } = {},
): Promise<OpenedToolbelt> {
  const modules = await loadModules();
  const cwd = resolve(input.cwd ?? process.cwd());
  const repoRoot = await findRepoRoot(cwd);
  return {
    repoRoot,
    toolbelt: Object.freeze({
      ...modules,
      vitest: createProjectAwareVitest(
        modules.vitest,
        modules.execa,
        repoRoot ?? cwd,
      ),
      ...(repoRoot === null
        ? {}
        : { simpleGit: simpleGit({ baseDir: repoRoot }) }),
    }),
  };
}
