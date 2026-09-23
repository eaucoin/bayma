// Installs Ardour's engine, libardour, into this skill's ardour/ folder: the
// Ubuntu 24.04 packages packages.json pins, unpacked rather than installed,
// with env.json, the environment ardour_host.py runs Ardour's Lua session
// with. Linux x64, with glibc 2.39 or newer (Ubuntu 24.04's).
//
//   bun install.ts
//
// The packages are Ubuntu's GPL builds of Ardour 8.4, its LV2 instruments and
// effects, and the libraries those load, found by their ELF dependencies.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

interface Pinned {
  mirror: string;
  packages: { name: string; filename: string; sha256: string }[];
}

const SKILL = import.meta.dir;
const TARGET = join(SKILL, "ardour");
// Assembled beside TARGET, which it replaces only once it is complete.
const STAGING = `${TARGET}.partial`;
const GLIBC_FLOOR = [2, 39];
// Instruments the install must leave Ardour able to load.
const REQUIRED_PLUGINS = [
  "Red Zeppelin Drumkit",
  "Calf Monosynth",
  "GxAmplifier-X",
  "ACE Reasonable Synth",
  "ACE Reverb",
];

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

async function fetchPinned(url: string, sha256: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== sha256)
    throw new Error(`${url} is not the pinned file (sha256 ${digest})`);
  return bytes;
}

/** Unpacks a Debian package's files, which it carries as a zstd tarball. */
function unpackDeb(deb: Uint8Array, name: string, work: string, into: string) {
  const archive = Buffer.from(deb);
  let offset = 8; // "!<arch>\n"
  while (offset + 60 <= archive.length) {
    const member = archive.toString("latin1", offset, offset + 16).trim();
    const size = Number(archive.toString("latin1", offset + 48, offset + 58));
    const start = offset + 60;
    if (member.startsWith("data.tar.zst")) {
      const tarball = join(work, `${name}.tar`);
      writeFileSync(
        tarball,
        Bun.zstdDecompressSync(archive.subarray(start, start + size)),
      );
      run(["tar", "-xf", tarball, "-C", into]);
      rmSync(tarball);
      return;
    }
    offset = start + size + (size % 2);
  }
  throw new Error(`${name} carries no data.tar.zst`);
}

const LIBRARIES = join("usr", "lib", "x86_64-linux-gnu");

/** The library directory and those under it holding shared libraries, such
 * as pulseaudio/, relative to it. */
function libraryDirectories(libraries: string): string[] {
  return [
    "",
    ...readdirSync(libraries).filter((name) => {
      const path = join(libraries, name);
      return (
        statSync(path).isDirectory() &&
        readdirSync(path).some((file) => /\.so(\.\d+)*$/.test(file))
      );
    }),
  ];
}

/** The environment of Debian's ardour8-lua wrapper, for the tree unpacked at
 * stagedRoot and to be installed at root, with Ardour's settings in config. */
function ardourEnvironment(stagedRoot: string, root: string, config: string) {
  const loaderPath = [
    join(root, "usr", "lib", "ardour8"),
    ...libraryDirectories(join(stagedRoot, LIBRARIES)).map((directory) =>
      join(root, LIBRARIES, directory),
    ),
  ];
  return {
    command: join(root, "usr", "lib", "ardour8", "luasession"),
    env: {
      LD_LIBRARY_PATH: loaderPath.join(":"),
      ARDOUR_DATA_PATH: join(root, "usr", "share", "ardour8"),
      ARDOUR_CONFIG_PATH: join(root, "etc", "ardour8"),
      ARDOUR_DLL_PATH: join(root, "usr", "lib", "ardour8"),
      LV2_PATH: join(root, "usr", "lib", "lv2"),
      XDG_CONFIG_HOME: config,
    },
  };
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

const pinned = JSON.parse(
  readFileSync(join(SKILL, "packages.json"), "utf8"),
) as Pinned;
let installedTarget = false;
const work = mkdtempSync(join(tmpdir(), "bayma-platform-ardour-"));
try {
  rmSync(STAGING, { recursive: true, force: true });
  const stagedRoot = join(STAGING, "root");
  mkdirSync(stagedRoot, { recursive: true });
  mkdirSync(join(STAGING, "config"));
  // Four at a time: the archive is shared, and the packages are many.
  const queue = [...pinned.packages];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const deb = await fetchPinned(
          pinned.mirror + entry.filename,
          entry.sha256,
        );
        unpackDeb(deb, basename(entry.filename, ".deb"), work, stagedRoot);
      }
    }),
  );

  const environment = ardourEnvironment(
    stagedRoot,
    join(TARGET, "root"),
    join(TARGET, "config"),
  );
  writeFileSync(
    join(STAGING, "env.json"),
    JSON.stringify(environment, null, 2) + "\n",
  );

  rmSync(TARGET, { recursive: true, force: true });
  renameSync(STAGING, TARGET);
  installedTarget = true;

  // A session, created and closed, proves the engine runs and has its
  // instruments; plugins are only listed once a session exists.
  const check = join(work, "check.lua");
  writeFileSync(
    check,
    [
      'AudioEngine:set_backend("None (Dummy)", "", "")',
      "AudioEngine:start()",
      `create_session(${JSON.stringify(join(work, "session"))}, "check", 48000)`,
      "local names = {}",
      "for p in ARDOUR.LuaAPI.list_plugins():iter() do names[#names + 1] = p.name end",
      'print("PLUGINS " .. table.concat(names, "|"))',
      "close_session()",
    ].join("\n"),
  );
  const output = run([environment.command, check], {
    env: { ...process.env, ...environment.env },
  });
  const plugins = (
    output.split("\n").find((line) => line.startsWith("PLUGINS ")) ?? ""
  )
    .slice(8)
    .split("|");
  const missing = REQUIRED_PLUGINS.filter((name) => !plugins.includes(name));
  if (missing.length > 0)
    throw new Error(`Ardour cannot load: ${missing.join(", ")}`);
  const size = run(["du", "-sh", TARGET]).split("\t")[0];
  console.log(
    `Installed Ardour 8.4 in ${TARGET} (${size}) with ${new Set(plugins).size} plugins`,
  );
} catch (error) {
  rmSync(STAGING, { recursive: true, force: true });
  // An install that fails its first start is no install.
  if (installedTarget) rmSync(TARGET, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(work, { recursive: true, force: true });
}
