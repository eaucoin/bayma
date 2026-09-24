// Builds Ardour's engine, libardour, into this skill's ardour/ folder, and
// writes compile_flags.txt, with which a bayma C++ session in this folder
// compiles against libardour's headers and loads it. The engine is Ardour's
// release source, built as Ardour's Linux releases are, with libstdc++, by
// Ubuntu 24.04's Clang against Ubuntu 24.04's libraries; packages.json pins
// them with the instruments and effects sessions use. Linux x64, with glibc
// 2.39 or newer (Ubuntu 24.04's).
//
//   bun install.ts
//
// Ardour's engine is some five hundred files of C++: building it takes a
// while, and says how far it has come.

import { createHash } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

interface Pinned {
  mirror: string;
  packages: { name: string; filename: string; sha256: string }[];
}

const ARDOUR = {
  version: "9.8.0",
  url: "https://community.ardour.org/src/Ardour-9.8.0.tar.bz2",
  sha256: "1f1a0ae658fb3b10e3fa6f9cab952ab6500955594c3773c5e9421f5e42b23d59",
};

const SKILL = import.meta.dir;
const TARGET = join(SKILL, "ardour");
// Assembled beside TARGET, which it replaces only once it is complete.
const STAGING = `${TARGET}.partial`;
// The build's own tree: the packages, the toolchain, and Ardour's source.
const BUILD = `${TARGET}.build`;
const COMPILE_FLAGS = join(SKILL, "compile_flags.txt");
const GLIBC_FLOOR = [2, 39];
const MULTIARCH = join("usr", "lib", "x86_64-linux-gnu");

// What Ardour builds of itself: the engine, its headless audio backend, its
// panners, its own plugins, and its analysis plugins.
const TARGETS = [
  "libardour",
  "dummy_audiobackend",
  "libardour_pan1in2out",
  "libardour_pan2in2out",
  "libardour_panbalance",
  "libardour_panvbap",
  "a-comp",
  "a-delay",
  "a-eq",
  "a-exp",
  "a-fluidsynth",
  "a-reverb",
  "reasonablesynth",
  "libardourvampplugins",
  "libardourvamppyin",
];
// What Ardour installs beside the libraries, as its build scripts do.
const SHARED_DATA: [string, RegExp][] = [
  ["export", /\.(preset|format)$/],
  ["scripts", /^[^_].*\.lua$/],
  ["plugin_metadata", /^plugin/],
  ["patchfiles", /\.midnam$/],
  ["midi_maps", /\.map$/],
  ["media", /./],
];
// The instruments and effects the install must leave Ardour able to load.
const REQUIRED_PLUGINS = [
  "Red Zeppelin Drumkit",
  "Calf Monosynth",
  "GxAmplifier-X",
  "ACE Reasonable Synth",
  "ACE Reverb",
];
// The machine's C and C++ runtime, which every process on it shares and no
// library of the skill's may bring another copy of.
const SYSTEM_LIBRARY =
  /^(ld-linux-x86-64\.so\.2|lib(c|m|mvec|dl|pthread|rt|resolv|util|anl|BrokenLocale)\.so\.\d+|libnss_\w+\.so\.\d+|libstdc\+\+\.so\.6|libgcc_s\.so\.1)$/;
// What only plugins' user interfaces need, which sessions never open.
const USER_INTERFACE = /^lib(gtk|gdk|X11|GL|GLX|OpenGL)[-.]/;
// The packages whose headers are the machine's own, which cells take from
// bayma instead, and the toolchain's.
const TOOLCHAIN_PACKAGE =
  /^(libc6-dev|linux-libc-dev|libcrypt-dev|libstdc\+\+-\d+-dev|libgcc-\d+-dev|lib(clang|llvm).*|clang.*|llvm.*|lld.*|binutils.*)$/;

function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")} failed: ${result.stderr}`);
  return result.stdout.toString();
}

/** Streams url to path, and proves it is the pinned file. */
async function fetchPinned(url: string, sha256: string, path: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`${url} answered HTTP ${response.status}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as never);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(path));
  const digest = hash.digest("hex");
  if (digest !== sha256)
    throw new Error(`${url} is not the pinned file (sha256 ${digest})`);
}

/**
 * Unpacks a Debian package's files into `into`, and returns them, relative
 * to it.
 */
function unpackDeb(deb: string, into: string): string[] {
  const archive = readFileSync(deb);
  let offset = 8; // "!<arch>\n"
  while (offset + 60 <= archive.length) {
    const member = archive.toString("latin1", offset, offset + 16).trim();
    const size = Number(archive.toString("latin1", offset + 48, offset + 58));
    const start = offset + 60;
    const data = archive.subarray(start, start + size);
    if (member.startsWith("data.tar")) {
      const tarball = `${deb}.tar`;
      writeFileSync(
        tarball,
        member.endsWith(".zst") ? Bun.zstdDecompressSync(data) : data,
      );
      const compression = member.endsWith(".xz") ? ["-J"] : [];
      run(["tar", ...compression, "-xf", tarball, "-C", into]);
      const files = run(["tar", ...compression, "-tf", tarball])
        .split("\n")
        .filter((file) => file && !file.endsWith("/"))
        .map((file) => file.replace(/^\.\//, ""));
      rmSync(tarball);
      return files;
    }
    offset = start + size + (size % 2);
  }
  throw new Error(`${deb} carries no data tarball`);
}

/** As Ubuntu's merged /usr has it: /lib and /lib64 are /usr's. */
function mergeUsr(root: string) {
  for (const directory of ["lib", "lib64"]) {
    const top = join(root, directory);
    const entry = lstatSync(top, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) continue;
    if (entry) {
      cpSync(top, join(root, "usr", directory), {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
      });
      rmSync(top, { recursive: true });
    }
    mkdirSync(join(root, "usr", directory), { recursive: true });
    symlinkSync(join("usr", directory), top);
  }
}

/** The libraries an ELF file names as needed, from its dynamic section. */
function neededLibraries(path: string): string[] {
  const file = readFileSync(path);
  if (file.readUInt32BE(0) !== 0x7f454c46) return [];
  const programHeaders = Number(file.readBigUInt64LE(0x20));
  const entrySize = file.readUInt16LE(0x36);
  const count = file.readUInt16LE(0x38);
  const loads: { vaddr: bigint; offset: bigint; size: bigint }[] = [];
  let dynamic: { offset: number; size: number } | undefined;
  for (let index = 0; index < count; index++) {
    const header = programHeaders + index * entrySize;
    const type = file.readUInt32LE(header);
    const offset = file.readBigUInt64LE(header + 8);
    const vaddr = file.readBigUInt64LE(header + 16);
    const size = file.readBigUInt64LE(header + 32);
    if (type === 1) loads.push({ vaddr, offset, size });
    if (type === 2) dynamic = { offset: Number(offset), size: Number(size) };
  }
  if (!dynamic) return [];
  let strings = 0n;
  const offsets: number[] = [];
  for (
    let entry = dynamic.offset;
    entry < dynamic.offset + dynamic.size;
    entry += 16
  ) {
    const tag = file.readBigInt64LE(entry);
    const value = file.readBigUInt64LE(entry + 8);
    if (tag === 0n) break;
    if (tag === 5n) strings = value; // DT_STRTAB
    if (tag === 1n) offsets.push(Number(value)); // DT_NEEDED
  }
  const segment = loads.find(
    (load) => strings >= load.vaddr && strings < load.vaddr + load.size,
  );
  if (!segment) return [];
  const base = Number(strings - segment.vaddr + segment.offset);
  return offsets.map((offset) => {
    const start = base + offset;
    return file.toString("latin1", start, file.indexOf(0, start));
  });
}

/**
 * What `files` need, found in `directories`, and what that needs in turn,
 * by name: all but the machine's own runtime, and all but what `files`
 * themselves are.
 */
function neededClosure(files: string[], directories: string[]) {
  const found = new Map<string, string>();
  const own = new Set(files.map((file) => basename(file)));
  const queue = [...files];
  while (queue.length > 0) {
    for (const needed of neededLibraries(queue.pop()!)) {
      if (found.has(needed) || own.has(needed) || SYSTEM_LIBRARY.test(needed))
        continue;
      const directory = directories.find((d) => existsSync(join(d, needed)));
      if (!directory)
        throw new Error(`nothing this skill pins provides ${needed}`);
      found.set(needed, join(directory, needed));
      queue.push(join(directory, needed));
    }
  }
  return found;
}

/** Every file under `directory` whose name matches, recursively. */
function filesUnder(directory: string, name: RegExp): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && name.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Copies the regular files under `from` that `keep` keeps to `to`. */
function copyFiles(from: string, to: string, keep: (path: string) => boolean) {
  for (const file of filesUnder(from, /./)) {
    const path = relative(from, file);
    if (!keep(path)) continue;
    mkdirSync(dirname(join(to, path)), { recursive: true });
    cpSync(file, join(to, path), { dereference: true });
  }
}

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This skill's Ardour runs on Linux x64 only.");
const glibc = run(["getconf", "GNU_LIBC_VERSION"]).trim().split(" ")[1]!;
const [major, minor] = glibc.split(".").map(Number);
if (
  major! < GLIBC_FLOOR[0]! ||
  (major === GLIBC_FLOOR[0] && minor! < GLIBC_FLOOR[1]!)
)
  throw new Error(
    `This skill's Ardour needs glibc ${GLIBC_FLOOR.join(".")} or newer (Ubuntu 24.04's); this system has ${glibc}.`,
  );
// Ardour's build is Python; bayma's is the one bayma runs.
const python = process.env.BAYMA_PYTHON_BIN;
if (!python)
  throw new Error(
    "Ardour builds with Python, which bayma provides: run this in a bayma Bun session.",
  );

const pinned = JSON.parse(
  readFileSync(join(SKILL, "packages.json"), "utf8"),
) as Pinned;
let installedTarget = false;
const started = Date.now();
const say = (what: string) =>
  console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${what}`);
try {
  rmSync(STAGING, { recursive: true, force: true });
  rmSync(BUILD, { recursive: true, force: true });
  const root = join(BUILD, "root");
  const debs = join(BUILD, "debs");
  mkdirSync(root, { recursive: true });
  mkdirSync(debs);
  mkdirSync(STAGING);

  // The packages, unpacked rather than installed, with each one's files.
  say(`fetching ${pinned.packages.length} packages`);
  const filesOf = new Map<string, string[]>();
  for (let index = 0; index < pinned.packages.length; index += 8)
    await Promise.all(
      pinned.packages.slice(index, index + 8).map(async (pkg) => {
        const deb = join(debs, basename(pkg.filename));
        await fetchPinned(pinned.mirror + pkg.filename, pkg.sha256, deb);
        filesOf.set(pkg.name, unpackDeb(deb, root));
        rmSync(deb);
      }),
    );
  mergeUsr(root);
  // Where the packages keep libraries: the usual directories, and those
  // under them that hold a package's private ones, such as pulseaudio/.
  const rootLibraries = [join(root, MULTIARCH), join(root, "usr", "lib")];
  for (const entry of readdirSync(join(root, MULTIARCH), {
    withFileTypes: true,
  }))
    if (
      entry.isDirectory() &&
      filesUnder(join(root, MULTIARCH, entry.name), /\.so(\.\d+)*$/).length > 0
    )
      rootLibraries.push(join(root, MULTIARCH, entry.name));

  // The toolchain, run from the packages with the libraries it needs.
  const llvm = join(root, "usr", "lib", "llvm-18", "bin");
  const tools = join(BUILD, "tools");
  mkdirSync(join(tools, "lib"), { recursive: true });
  mkdirSync(join(tools, "bin"));
  const toolchain = [
    join(llvm, "clang-18"),
    join(llvm, "lld"),
    join(llvm, "llvm-ar"),
    join(root, "usr", "bin", "pkgconf"),
    join(root, "usr", "bin", "bzip2"),
  ];
  for (const [name, path] of neededClosure(toolchain, [
    join(root, "usr", "lib", "llvm-18", "lib"),
    ...rootLibraries,
  ]))
    cpSync(path, join(tools, "lib", name), { dereference: true });
  symlinkSync(
    join(root, "usr", "bin", "pkgconf"),
    join(tools, "bin", "pkg-config"),
  );
  const clang = join(llvm, "clang");
  const buildEnv = {
    ...process.env,
    PATH: `${join(tools, "bin")}:${llvm}:${process.env.PATH}`,
    LD_LIBRARY_PATH: join(tools, "lib"),
    CC: `${clang} --sysroot=${root}`,
    CXX: `${clang}++ --sysroot=${root}`,
    AR: join(llvm, "llvm-ar"),
    PKG_CONFIG: join(tools, "bin", "pkg-config"),
    PKG_CONFIG_SYSROOT_DIR: root,
    PKG_CONFIG_LIBDIR: [
      join(root, MULTIARCH, "pkgconfig"),
      join(root, "usr", "share", "pkgconfig"),
      join(root, "usr", "lib", "pkgconfig"),
    ].join(":"),
    // Linked by the toolchain's own linker; Ardour's modules find the
    // engine's libraries beside them.
    LDFLAGS: "-fuse-ld=lld -Wl,-rpath,$ORIGIN/..",
    CFLAGS: "",
    CXXFLAGS: "",
  };

  // Ardour's source.
  say(`fetching Ardour ${ARDOUR.version}`);
  const tarball = join(BUILD, basename(ARDOUR.url));
  await fetchPinned(ARDOUR.url, ARDOUR.sha256, tarball);
  run(
    [
      "tar",
      `--use-compress-program=${join(root, "usr", "bin", "bzip2")}`,
      "-xf",
      tarball,
      "-C",
      BUILD,
    ],
    { env: buildEnv },
  );
  rmSync(tarball);
  const source = join(BUILD, `Ardour-${ARDOUR.version}`);
  const waf = (args: string[]) => {
    const log = join(BUILD, "waf.log");
    const result = Bun.spawnSync([python, "./waf", ...args], {
      cwd: source,
      env: buildEnv,
      stdout: Bun.file(log),
      stderr: "pipe",
    });
    if (result.exitCode !== 0)
      throw new Error(
        `waf ${args[0]} failed:\n${readFileSync(log, "utf8").slice(-4000)}${result.stderr}`,
      );
  };

  say("configuring Ardour");
  waf([
    "configure",
    `--prefix=${join(TARGET, "engine")}`,
    "--optimize",
    "--use-lld",
    "--with-backends=dummy",
    "--no-lxvst",
    "--no-vst3",
    "--no-windows-vst",
    "--no-nls",
    "--no-phone-home",
    "--noconfirm",
    "--libjack=weak",
    "--compile-database",
  ]);
  say(`building Ardour's engine on ${availableParallelism()} cores`);
  waf([
    "build",
    `-j${availableParallelism()}`,
    `--targets=${TARGETS.join(",")}`,
  ]);
  const destdir = join(BUILD, "destdir");
  waf(["install", `--destdir=${destdir}`, `--targets=${TARGETS.join(",")}`]);
  const engine = join(STAGING, "engine");
  renameSync(join(destdir, TARGET, "engine"), engine);
  const libraries = join(engine, "lib", "ardour9");
  const data = join(engine, "share", "ardour9");

  // What Ardour's build scripts install beside the libraries: its plugins'
  // descriptions, its presets, scripts, and maps, and its configuration.
  for (const bundle of readdirSync(join(source, "libs", "plugins")))
    if (existsSync(join(libraries, "LV2", bundle)))
      for (const template of filesUnder(
        join(source, "libs", "plugins", bundle),
        /\.ttl\.in$/,
      ))
        writeFileSync(
          join(libraries, "LV2", bundle, basename(template, ".in")),
          readFileSync(template, "utf8").replaceAll("@LIB_EXT@", ".so"),
        );
  for (const [directory, name] of SHARED_DATA)
    copyFiles(
      join(source, "share", directory),
      join(data, directory),
      (path) => name.test(basename(path)) && basename(path) !== "wscript",
    );
  mkdirSync(join(engine, "etc", "ardour9"), { recursive: true });
  cpSync(
    join(source, "system_config"),
    join(engine, "etc", "ardour9", "system_config"),
  );

  // The instruments and effects, and the LV2 specifications they are
  // described in.
  const lv2 = join(STAGING, "lv2");
  cpSync(join(root, "usr", "lib", "lv2"), lv2, {
    recursive: true,
    dereference: true,
  });

  // What the engine and the plugins need, from the packages.
  say("gathering the libraries the engine needs");
  const dependencies = join(STAGING, "lib");
  mkdirSync(dependencies);
  const loadable = [
    ...filesUnder(libraries, /\.so(\.\d+)*$/),
    ...filesUnder(lv2, /\.so$/),
  ];
  for (const [name, path] of neededClosure(loadable, [
    ...filesUnder(libraries, /\.so(\.\d+)*$/).map(dirname),
    ...rootLibraries,
  ]))
    if (!path.startsWith(libraries))
      cpSync(path, join(dependencies, name), { dereference: true });
  // Ardour opens the plugins itself, and nothing tells the dynamic linker
  // where their libraries are, so a session loads them first: those their
  // binaries need, but for their user interfaces'.
  const pluginLibraries = new Set(
    [
      ...filesUnder(join(libraries, "LV2"), /\.so$/),
      ...filesUnder(lv2, /\.so$/),
    ]
      .map(neededLibraries)
      .filter((needed) => !needed.some((name) => USER_INTERFACE.test(name)))
      .flat()
      .filter((name) => existsSync(join(dependencies, name))),
  );

  // The headers cells compile against: Ardour's, as its build includes
  // them, and its libraries' as their packages install them, without the
  // C and C++ runtime's, which cells take from bayma.
  say("gathering the headers");
  const database = JSON.parse(
    readFileSync(join(source, "build", "compile_commands.json"), "utf8"),
  ) as {
    directory: string;
    file: string;
    arguments?: string[];
    command?: string;
  }[];
  const session = database.find((entry) =>
    entry.file.endsWith("libs/ardour/session.cc"),
  );
  if (!session?.arguments)
    throw new Error("Ardour's build did not record how it compiled libardour");
  const include = join(STAGING, "include");
  const flags = [
    "-stdlib=libstdc++",
    "-std=gnu++17",
    `-DBAYMA_ARDOUR_ROOT="${TARGET}"`,
  ];
  const systemHeaders = new Set<string>();
  for (const [name, files] of filesOf)
    if (TOOLCHAIN_PACKAGE.test(name))
      for (const file of files) systemHeaders.add(file);
  const copied = new Set<string>();
  const args = session.arguments;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith("-D")) {
      // What only the library's own sources see.
      if (
        !/^-D(LIBARDOUR_DLL_EXPORTS|DATA_DIR|CONFIG_DIR|LOCALEDIR|LIBARDOUR)=/.test(
          arg,
        )
      )
        flags.push(arg);
      continue;
    }
    if (!arg.startsWith("-I")) continue;
    const directory = resolve(
      session.directory,
      arg.slice(2) || args[++index]!,
    );
    const underRoot = relative(root, directory);
    if (!underRoot.startsWith("..") && !isAbsolute(underRoot)) {
      const into = join(include, "deps", underRoot);
      if (!copied.has(into)) {
        copyFiles(directory, into, (path) => {
          const packaged = relative(root, join(directory, path));
          return (
            !systemHeaders.has(packaged) &&
            /\.(h|hh|hpp|hxx|ipp|tcc|inc|def)$|^[^.]+$/.test(basename(path))
          );
        });
        copied.add(into);
      }
      flags.push("-isystem", join(TARGET, "include", "deps", underRoot));
    } else {
      const underSource = relative(source, directory);
      const into = join(include, "ardour", underSource);
      if (!copied.has(into)) {
        copyFiles(directory, into, (path) =>
          /\.(h|hpp|hh|inc|tcc)$/.test(path),
        );
        copied.add(into);
      }
      flags.push(`-I${join(TARGET, "include", "ardour", underSource)}`);
    }
  }
  flags.push(
    `-L${join(TARGET, "lib")}`,
    `-L${join(TARGET, "engine", "lib", "ardour9")}`,
    "-lardour",
    ...[...pluginLibraries].sort().map((name) => `-l:${name}`),
  );
  mkdirSync(join(STAGING, "config"));
  writeFileSync(join(STAGING, "compile_flags.txt"), flags.join("\n") + "\n");

  rmSync(TARGET, { recursive: true, force: true });
  renameSync(STAGING, TARGET);
  installedTarget = true;
  renameSync(join(TARGET, "compile_flags.txt"), COMPILE_FLAGS);

  // A program built as a cell is compiled proves the engine starts and loads
  // the instruments and effects.
  say("checking the engine");
  const check = join(BUILD, "check.cc");
  writeFileSync(
    check,
    [
      '#include "ardour_session.h"',
      '#include "ardour/plugin_manager.h"',
      "#include <cstdio>",
      "#include <cstdlib>",
      "int main() {",
      "  ARDOUR::AudioEngine *engine = bayma_ardour::start();",
      "  for (const auto &info : ARDOUR::PluginManager::instance().lv2_plugin_info())",
      '    std::printf("plugin %s\\n", info->name.c_str());',
      '  std::printf("running %d\\n", engine->running());',
      "  // The engine's threads outlive main; what the check says is all.",
      "  std::fflush(stdout);",
      "  std::_Exit(0);",
      "}",
    ].join("\n"),
  );
  const compileFlags = readFileSync(COMPILE_FLAGS, "utf8").trim().split("\n");
  run(
    [
      `${clang}++`,
      `--sysroot=${root}`,
      "-fuse-ld=lld",
      `-I${SKILL}`,
      ...compileFlags,
      check,
      // What the program uses beside libardour: a linker, unlike a bayma
      // session, finds only what it is named.
      "-lpbd",
      "-ltemporal",
      "-lsigc-2.0",
      "-lglibmm-2.4",
      "-lglib-2.0",
      "-o",
      join(BUILD, "check"),
    ],
    { env: buildEnv },
  );
  const output = run([join(BUILD, "check")], {
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [
        join(TARGET, "lib"),
        join(TARGET, "engine", "lib", "ardour9"),
      ].join(":"),
    },
  });
  const missing = REQUIRED_PLUGINS.filter(
    (plugin) => !output.includes(`plugin ${plugin}\n`),
  );
  if (!output.includes("running 1") || missing.length > 0)
    throw new Error(
      `Ardour's engine did not ${missing.length ? `load ${missing.join(", ")}` : "start"}:\n${output.slice(-2000)}`,
    );
  const size = run(["du", "-sh", TARGET]).split("\t")[0];
  say(
    `Installed Ardour ${ARDOUR.version}'s engine in ${TARGET} (${size}), with ${
      output.match(/^plugin /gm)?.length ?? 0
    } plugins, and ${COMPILE_FLAGS}`,
  );
} catch (error) {
  rmSync(STAGING, { recursive: true, force: true });
  // An install whose engine does not start is no install.
  if (installedTarget) {
    rmSync(TARGET, { recursive: true, force: true });
    rmSync(COMPILE_FLAGS, { force: true });
  }
  throw error;
} finally {
  rmSync(BUILD, { recursive: true, force: true });
}
