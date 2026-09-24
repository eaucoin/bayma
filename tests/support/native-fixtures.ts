import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Shared libraries for C and C++ sessions to load, built as a project or a
// Linux distribution would ship them: with the pinned LLVM release's clang
// that provisioning keeps in .work, against the sysroot the host is built
// against, and with either standard library. Linux only.

const repoRoot = resolve(import.meta.dir, "..", "..");
const clangDir = join(repoRoot, ".work", "clang");
const payloadClang = join(repoRoot, "dist", "payload", "clang");
const TRIPLE = "x86_64-unknown-linux-gnu";

export interface SharedLibrary {
  /** The library's file name, such as libshapes.so, which is its soname. */
  name: string;
  sources: Record<string, string>;
  stdlib: "libc++" | "libstdc++";
  /** Libraries built beside it that it needs, by file name. */
  needs?: string[];
}

/** Writes `files` under `root`, making directories as needed. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/**
 * Builds `library` into `libDir`, with the headers under `includeDir`. It
 * names what it needs without a runpath, as a library kept in a project does.
 */
export function buildSharedLibrary(
  library: SharedLibrary,
  libDir: string,
  includeDir: string,
): string {
  const clang = join(clangDir, "llvm", "bin", "clang++");
  if (!existsSync(clang))
    throw new Error(`${clang} is missing; run bun run provision`);
  const sourceDir = join(libDir, `${library.name}.src`);
  writeTree(sourceDir, library.sources);
  const standardLibrary =
    library.stdlib === "libc++"
      ? [
          "-nostdinc++",
          "-isystem",
          join(payloadClang, "include", TRIPLE, "c++", "v1"),
          "-isystem",
          join(payloadClang, "include", "c++", "v1"),
          "-nostdlib++",
          join(payloadClang, "lib", TRIPLE, "libc++.so.1"),
          join(payloadClang, "lib", TRIPLE, "libc++abi.so.1"),
        ]
      : [
          "-stdlib=libstdc++",
          "-nostdlib++",
          // The system's, which sessions run with.
          "/lib/x86_64-linux-gnu/libstdc++.so.6",
        ];
  const output = join(libDir, library.name);
  const result = spawnSync(
    clang,
    [
      `--sysroot=${join(clangDir, "sysroot", "build")}`,
      "-std=c++17",
      "-fPIC",
      "-shared",
      "-O1",
      `-I${includeDir}`,
      ...Object.keys(library.sources).map((path) => join(sourceDir, path)),
      ...standardLibrary,
      `-L${libDir}`,
      ...(library.needs ?? []).map((needed) => `-l:${needed}`),
      `-Wl,-soname,${library.name}`,
      "-o",
      output,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(`building ${library.name} failed:\n${result.stderr}`);
  return output;
}
