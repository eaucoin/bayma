import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLANG } from "../platforms.ts";
import { extractDeb } from "../shared/deb.ts";
import { fetchPinned } from "../shared/download.ts";
import { copyTree, ensureDir, walkFiles } from "../shared/files.ts";
import { sha256File, sha256Text } from "../shared/hashing.ts";
import { run, runOrThrow } from "../shared/process.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
  type RuntimePayload,
} from "./payload.ts";

// The C and C++ payload, which both runtimes share: bayma-cpp-host, built from
// this repository's sources against the pinned LLVM release's Clang
// Interpreter, and what cells compile and run against. Clang's resource
// headers everywhere; on Linux also libc++, glibc's and Linux's C headers at
// the glibc floor, libstdc++'s headers for sessions that choose it, and
// libatomic, while macOS cells use the SDK and the system's libc++.

/** Where the host's sources live. */
const NATIVE_DIR = join("packages", "runtime-cpp", "native");
const HOST = "bayma-cpp-host";
const LLVM_MAJOR = CLANG.llvmVersion.split(".")[0]!;
const IS_LINUX = process.platform === "linux";
/** The target triple the Linux release names its libc++ directories after. */
const LINUX_TRIPLE = "x86_64-unknown-linux-gnu";
/** The libc++ libraries Linux cells load, in dependency order after libatomic. */
const LIBCXX_LIBRARIES = ["libunwind.so.1", "libc++abi.so.1", "libc++.so.1"];

/**
 * Whether the host's build or the payload needs a member of the LLVM release:
 * most of the release is tools neither does.
 */
function llvmMember(path: string): boolean {
  return (
    /^bin\/(clang|clang\+\+|clang-\d+|clang-format|llvm-config)$/.test(path) ||
    (IS_LINUX && /^bin\/llvm-read(elf|obj)$/.test(path)) ||
    /^include\/(llvm|llvm-c|clang|clang-c)\//.test(path) ||
    // Every library `llvm-config --libs` names, which includes Polly's.
    /^lib\/lib(clang[A-Z]|LLVM|Polly)\w*\.a$/.test(path) ||
    // macOS: the release's libraries are LLVM bitcode, which only its own
    // libLTO can read.
    (!IS_LINUX && path === "lib/libLTO.dylib") ||
    path.startsWith(`lib/clang/${LLVM_MAJOR}/include/`) ||
    (IS_LINUX &&
      (path.startsWith("include/c++/v1/") ||
        path.startsWith(`include/${LINUX_TRIPLE}/`) ||
        LIBCXX_LIBRARIES.some((library) =>
          path.startsWith(`lib/${LINUX_TRIPLE}/${library}`),
        )))
  );
}

/** Runs tar over the decompressed stream of a zstd-compressed tarball. */
async function tarZstd(archive: string, tarArgs: string[]): Promise<string> {
  // The release is compressed with a window beyond zstd's default limit.
  return (
    await runOrThrow([
      "bash",
      "-c",
      'set -o pipefail; zstd -dcq --long=31 "$1" | tar "${@:2}"',
      "bash",
      archive,
      ...tarArgs,
    ])
  ).stdout;
}

/** The parts of the LLVM release that build the host and ship with it. */
async function provisionLlvm(context: ProvisionContext): Promise<string> {
  const directory = join(context.workDir, "clang", "llvm");
  // Which parts is part of what the directory holds.
  const identity = `${CLANG.llvm.sha256}:${sha256Text(llvmMember.toString())}`;
  if (isProvisioned(context, directory, identity)) return directory;
  resetDirectory(directory);
  ensureDir(directory);
  const archive = await fetchPinned(
    CLANG.llvm,
    context.downloadsDir,
    `LLVM ${CLANG.llvmVersion}`,
  );
  // Files only: tar extracts a listed directory whole, and then reports the
  // files listed after it as missing.
  const members = (await tarZstd(archive, ["-t"]))
    .split("\n")
    .filter(
      (member) =>
        !member.endsWith("/") && llvmMember(member.replace(/^[^/]+\//, "")),
    );
  const list = join(context.workDir, "clang", "llvm-members.txt");
  writeFileSync(list, members.join("\n") + "\n");
  await tarZstd(archive, [
    "-x",
    "-C",
    directory,
    "--strip-components=1",
    "-T",
    list,
  ]);
  rmSync(list);
  const version = (
    await runOrThrow([join(directory, "bin", "llvm-config"), "--version"])
  ).stdout.trim();
  if (version !== CLANG.llvmVersion)
    throw new Error(`the pinned LLVM release reports ${version}`);
  // The extracted parts are all later builds read; the release itself is
  // over a gigabyte and is not kept.
  rmSync(archive);
  markProvisioned(directory, identity);
  return directory;
}

/**
 * Linux: the Ubuntu packages, unpacked twice. `cells` holds only what cells
 * compile against and load; `build` holds everything the host is built
 * against.
 */
async function provisionSysroot(
  context: ProvisionContext,
): Promise<{ cells: string; build: string } | undefined> {
  const packages = CLANG.sysroot;
  if (!packages) return undefined;
  const directory = join(context.workDir, "clang", "sysroot");
  const layout = {
    cells: join(directory, "cells"),
    build: join(directory, "build"),
  };
  const identity = [...packages.cells, ...packages.build]
    .map((pinned) => pinned.sha256)
    .join(":");
  if (isProvisioned(context, directory, identity)) return layout;
  resetDirectory(directory);
  ensureDir(layout.cells);
  ensureDir(layout.build);
  for (const pinned of [...packages.cells, ...packages.build]) {
    const deb = await fetchPinned(
      pinned,
      context.downloadsDir,
      basename(pinned.url),
    );
    await extractDeb(deb, layout.build);
    if (packages.cells.includes(pinned)) await extractDeb(deb, layout.cells);
  }
  markProvisioned(directory, identity);
  return layout;
}

/** The pinned zstd release's library sources. */
async function provisionZstd(context: ProvisionContext): Promise<string> {
  const directory = join(context.workDir, "clang", "zstd");
  if (isProvisioned(context, directory, CLANG.zstd.sha256)) return directory;
  resetDirectory(directory);
  ensureDir(directory);
  const archive = await fetchPinned(
    CLANG.zstd,
    context.downloadsDir,
    `zstd ${CLANG.zstdVersion}`,
  );
  await runOrThrow([
    "tar",
    "-xzf",
    archive,
    "-C",
    directory,
    "--strip-components=1",
  ]);
  markProvisioned(directory, CLANG.zstd.sha256);
  return directory;
}

async function macosSdk(): Promise<string> {
  return (await runOrThrow(["xcrun", "--show-sdk-path"])).stdout.trim();
}

/** What every compilation of the host and its zstd shares. */
async function targetFlags(sysroot: string | undefined): Promise<string[]> {
  return IS_LINUX
    ? [`--sysroot=${sysroot}`]
    : [
        "-isysroot",
        await macosSdk(),
        `-mmacosx-version-min=${CLANG.llvm.macosMinimum}`,
      ];
}

/**
 * The symbols the JIT resolves in the host, exported by name and kept even
 * though nothing in the host calls them.
 */
function exportFlags(buildDir: string, symbols: string[]): string[] {
  if (IS_LINUX) {
    const list = join(buildDir, "exports.dynamic-list");
    writeFileSync(list, `{\n${symbols.map((s) => `  ${s};`).join("\n")}\n};\n`);
    return [
      `-Wl,--dynamic-list=${list}`,
      ...symbols.map((symbol) => `-Wl,--undefined=${symbol}`),
    ];
  }
  const list = join(buildDir, "exports.txt");
  writeFileSync(list, symbols.map((symbol) => `_${symbol}\n`).join(""));
  return [
    `-Wl,-exported_symbols_list,${list}`,
    ...symbols.map((symbol) => `-Wl,-u,_${symbol}`),
  ];
}

async function buildHost(
  context: ProvisionContext,
  llvm: string,
  zstd: string,
  sysroot: string | undefined,
): Promise<string> {
  const buildDir = join(context.workDir, "clang", "build");
  resetDirectory(buildDir);
  ensureDir(buildDir);
  const clang = join(llvm, "bin", "clang");
  const clangxx = join(llvm, "bin", "clang++");
  const llvmConfig = join(llvm, "bin", "llvm-config");
  const target = await targetFlags(sysroot);

  const objects: string[] = [];
  // zstd's x86-64 assembly is its only non-portable part, and LLVM only
  // needs its portable API.
  for (const part of ["common", "compress", "decompress"]) {
    for (const source of walkFiles(join(zstd, "lib", part))) {
      if (!source.endsWith(".c")) continue;
      const object = join(buildDir, `zstd-${part}-${basename(source, ".c")}.o`);
      await runOrThrow([
        clang,
        ...target,
        "-O2",
        "-DZSTD_DISABLE_ASM",
        "-c",
        source,
        "-o",
        object,
      ]);
      objects.push(object);
    }
  }

  // The host's sources keep the release's clang-format style
  // (native/.clang-format) and every warning; LLVM's headers are the
  // release's own business.
  const sources = join(context.repoRoot, NATIVE_DIR, "src");
  const sourceFiles = walkFiles(sources).filter((path) =>
    /\.(cpp|h)$/.test(path),
  );
  await runOrThrow([
    join(llvm, "bin", "clang-format"),
    "--dry-run",
    "-Werror",
    ...sourceFiles,
  ]);
  const cxxflags = (await runOrThrow([llvmConfig, "--cxxflags"])).stdout
    .trim()
    .split(/\s+/)
    .flatMap((flag) =>
      flag.startsWith("-I") ? ["-isystem", flag.slice(2)] : [flag],
    );
  for (const source of sourceFiles) {
    if (!source.endsWith(".cpp")) continue;
    const object = join(buildDir, `${basename(source, ".cpp")}.o`);
    await runOrThrow([
      clangxx,
      ...target,
      ...cxxflags,
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-c",
      source,
      "-o",
      object,
    ]);
    objects.push(object);
  }

  const host = join(buildDir, HOST);
  // What every platform's host exports, and on Linux the C runtime's
  // emulated-TLS entry point, which the host answers for cells.
  const exports = ["exports.txt", ...(IS_LINUX ? ["exports-linux.txt"] : [])]
    .flatMap((list) =>
      readFileSync(join(context.repoRoot, NATIVE_DIR, list), "utf8").split(
        "\n",
      ),
    )
    .filter(Boolean);
  const clangLibraries = readdirSync(join(llvm, "lib"))
    .filter((name) => /^libclang[A-Z]\w*\.a$/.test(name))
    .sort()
    .map((name) => join(llvm, "lib", name));
  const llvmLibraries = (
    await runOrThrow([llvmConfig, "--libs", "--link-static"])
  ).stdout
    .trim()
    .split(/\s+/);
  await runOrThrow([
    clangxx,
    ...target,
    "-o",
    host,
    ...objects,
    `-L${join(llvm, "lib")}`,
    ...exportFlags(buildDir, exports),
    ...(IS_LINUX
      ? [
          "-Wl,--gc-sections",
          // The host's own C++ runtime stays private, so cells see one:
          // libc++. The shared libgcc_s unwinder is where the JIT registers
          // the frames of the code it compiles.
          "-static-libstdc++",
          "-Wl,--start-group",
          ...clangLibraries,
          ...llvmLibraries,
          "-Wl,--end-group",
          "-lpthread",
          "-lrt",
          "-ldl",
          "-lm",
          "-l:libz.a",
        ]
      : [
          "-Wl,-dead_strip",
          // The libraries are bitcode, so linking them compiles what the host
          // reaches. Apple's linker compiles it with the release's libLTO,
          // keeping what it compiled for the next build.
          `-Wl,-lto_library,${join(llvm, "lib", "libLTO.dylib")}`,
          `-Wl,-cache_path_lto,${join(context.workDir, "clang", "lto-cache")}`,
          ...clangLibraries,
          ...llvmLibraries,
          "-lz",
        ]),
  ]);
  return host;
}

/** The newest glibc symbol version `binary` requires must be at the floor. */
async function assertGlibcFloor(binary: string, llvm: string): Promise<void> {
  const floor = CLANG.glibcFloor;
  if (!floor) return;
  const versions = (
    await runOrThrow([
      join(llvm, "bin", "llvm-readelf"),
      "--version-info",
      binary,
    ])
  ).stdout.match(/GLIBC_\d+(\.\d+)*/g);
  const newest = [...new Set(versions ?? [])]
    .map((version) => version.slice("GLIBC_".length).split(".").map(Number))
    .sort((a, b) => a[0]! - b[0]! || (a[1] ?? 0) - (b[1] ?? 0))
    .at(-1);
  const [major, minor] = floor.split(".").map(Number);
  if (
    newest &&
    (newest[0]! > major! || (newest[0] === major && (newest[1] ?? 0) > minor!))
  )
    throw new Error(
      `${basename(binary)} requires glibc ${newest.join(".")}, above the floor of ${floor}`,
    );
}

/** Lay out the runtime directory the payload carries. */
function assembleRuntime(
  root: string,
  host: string,
  llvm: string,
  sysroot: { cells: string } | undefined,
  licenses: Record<string, string>,
): void {
  ensureDir(join(root, "bin"));
  copyFileSync(host, join(root, "bin", HOST));
  chmodSync(join(root, "bin", HOST), 0o755);
  const resourceHeaders = join("lib", "clang", LLVM_MAJOR, "include");
  copyTree(join(llvm, resourceHeaders), join(root, resourceHeaders));
  if (sysroot) {
    copyTree(join(llvm, "include", "c++"), join(root, "include", "c++"));
    copyTree(
      join(llvm, "include", LINUX_TRIPLE),
      join(root, "include", LINUX_TRIPLE),
    );
    const libraries = join(root, "lib", LINUX_TRIPLE);
    ensureDir(libraries);
    for (const library of LIBCXX_LIBRARIES)
      copyFileSync(
        join(llvm, "lib", LINUX_TRIPLE, library),
        join(libraries, library),
      );
    copyFileSync(
      join(sysroot.cells, "usr", "lib", "x86_64-linux-gnu", "libatomic.so.1"),
      join(libraries, "libatomic.so.1"),
    );
    copyTree(
      join(sysroot.cells, "usr", "include"),
      join(root, "sysroot", "usr", "include"),
    );
    // Clang finds libstdc++'s headers through the GCC installation beside
    // them, which it knows by its crtbegin.o.
    const gcc = join("usr", "lib", "gcc", "x86_64-linux-gnu");
    for (const version of readdirSync(join(sysroot.cells, gcc))) {
      ensureDir(join(root, "sysroot", gcc, version));
      copyFileSync(
        join(sysroot.cells, gcc, version, "crtbegin.o"),
        join(root, "sysroot", gcc, version, "crtbegin.o"),
      );
    }
  }
  ensureDir(join(root, "licenses"));
  for (const [name, path] of Object.entries(licenses))
    copyFileSync(path, join(root, "licenses", `${name}.txt`));
}

/**
 * Runs one cell in each language through the assembled runtime, the way a
 * session would, and proves it answers.
 */
async function smokeTest(root: string): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "bayma-cpp-smoke-"));
  try {
    for (const language of ["c", "c++"]) {
      const spec = join(workspace, `${language}.json`);
      const prefix = "@@bayma-smoke@@";
      writeFileSync(
        spec,
        JSON.stringify({
          schema_version: 1,
          event_prefix: prefix,
          code: "40 + 2",
          durability_mode: "ephemeral",
          checkpoint_json: null,
        }),
      );
      const result = await run(
        [
          join(root, "bin", HOST),
          `--language=${language}`,
          ...(IS_LINUX ? [] : [`--sysroot=${await macosSdk()}`]),
        ],
        { cwd: workspace, input: `:exec ${spec}\n` },
      );
      const answered = result.stdout.includes(
        `${prefix}{"kind":"result","text":"42"}\n`,
      );
      if (result.status !== 0 || !answered)
        throw new Error(
          `${HOST} --language=${language} did not answer 40 + 2:\n${result.stdout}${result.stderr}`,
        );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export async function provisionClang(
  context: ProvisionContext,
): Promise<Record<"c" | "cpp", RuntimePayload>> {
  const root = join(context.workDir, "clang", "runtime");
  const sysrootPins = CLANG.sysroot
    ? [...CLANG.sysroot.cells, ...CLANG.sysroot.build]
    : [];
  const identity = [
    CLANG.llvm.sha256,
    CLANG.zstd.sha256,
    ...sysrootPins.map((pinned) => pinned.sha256),
    ...Object.values(CLANG.licenses).map((pinned) => pinned.sha256),
    // The build recipe is this file.
    sha256File(fileURLToPath(import.meta.url)),
    ...walkFiles(join(context.repoRoot, NATIVE_DIR)).map(sha256File),
  ].join(":");
  if (!isProvisioned(context, root, identity)) {
    const llvm = await provisionLlvm(context);
    const sysroot = await provisionSysroot(context);
    const zstd = await provisionZstd(context);
    // The licences of everything the runtime ships or the host links.
    const licenses: Record<string, string> = {
      "zstd-LICENSE": join(zstd, "LICENSE"),
    };
    for (const [project, pinned] of Object.entries(CLANG.licenses))
      licenses[`llvm-${project}-LICENSE`] = await fetchPinned(
        pinned,
        context.downloadsDir,
        `${project} licence`,
      );
    for (const pkg of ["libc6-dev", "linux-libc-dev", "gcc-12-base"])
      if (sysroot)
        licenses[`ubuntu-${pkg}-copyright`] = join(
          sysroot.cells,
          "usr",
          "share",
          "doc",
          pkg,
          "copyright",
        );
    const host = await buildHost(context, llvm, zstd, sysroot?.build);
    await assertGlibcFloor(host, llvm);
    resetDirectory(root);
    assembleRuntime(root, host, llvm, sysroot, licenses);
    // The host is rebuilt only when its sources or pins change.
    rmSync(join(context.workDir, "clang", "build"), {
      recursive: true,
      force: true,
    });
    await smokeTest(root);
    markProvisioned(root, identity);
  }
  const pins: Record<string, string> = {
    llvmVersion: CLANG.llvmVersion,
    llvmSha256: CLANG.llvm.sha256,
    zstdVersion: CLANG.zstdVersion,
    zstdSha256: CLANG.zstd.sha256,
    ...(CLANG.glibcFloor ? { glibcFloor: CLANG.glibcFloor } : {}),
    ...(CLANG.llvm.macosMinimum
      ? { macosMinimum: CLANG.llvm.macosMinimum }
      : {}),
  };
  const payload = (
    runtimeId: "c" | "cpp",
    variable: string,
  ): RuntimePayload => ({
    runtimeId,
    root,
    payloadDirectory: "clang",
    env: {},
    envPaths: { [variable]: `bin/${HOST}` },
    pathEnvPrepend: { PATH: ["bin"] },
    pins,
  });
  return {
    c: payload("c", "BAYMA_C_HOST_BIN"),
    cpp: payload("cpp", "BAYMA_CPP_HOST_BIN"),
  };
}
