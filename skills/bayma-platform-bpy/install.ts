// Installs Blender into this skill's blender/ folder: the official Linux
// release, unpacked, with any library it takes from the system that this
// system lacks, from system-libs.json, and env.json, the environment
// blender_host.py runs headless Blender with. Linux x64 only.
//
//   bun install.ts

import { createHash } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

interface SystemLibraries {
  mirror: string;
  libraries: {
    soname: string;
    package: string;
    filename: string;
    sha256: string;
  }[];
}

const BLENDER = {
  version: "5.2.2",
  url: "https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz",
  sha256: "84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168",
};

const SKILL = import.meta.dir;
const TARGET = join(SKILL, "blender");
// Assembled beside TARGET, which it replaces only once it is complete.
const STAGING = `${TARGET}.partial`;

function run(
  command: string[],
  env: Record<string, string | undefined> = process.env,
): string {
  const result = Bun.spawnSync(command, { env, stderr: "pipe" });
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

/** Unpacks a Debian package's files, which it carries as a zstd or xz tarball. */
function unpackDeb(deb: string, into: string) {
  const archive = readFileSync(deb);
  let offset = 8; // "!<arch>\n"
  while (offset + 60 <= archive.length) {
    const member = archive.toString("latin1", offset, offset + 16).trim();
    const size = Number(archive.toString("latin1", offset + 48, offset + 58));
    const start = offset + 60;
    const data = archive.subarray(start, start + size);
    if (member.startsWith("data.tar.zst")) {
      writeFileSync(`${deb}.tar`, Bun.zstdDecompressSync(data));
      run(["tar", "-xf", `${deb}.tar`, "-C", into]);
      return;
    }
    if (member.startsWith("data.tar.xz")) {
      writeFileSync(`${deb}.tar.xz`, data);
      run(["tar", "-xJf", `${deb}.tar.xz`, "-C", into]);
      return;
    }
    offset = start + size + (size % 2);
  }
  throw new Error(`${deb} carries no data tarball`);
}

/** The libraries Blender needs that neither the system nor lib provides. */
function missing(blender: string, lib: string): string[] {
  return run(["ldd", blender], { ...process.env, LD_LIBRARY_PATH: lib })
    .split("\n")
    .filter((line) => line.includes("not found"))
    .map((line) => line.trim().split(/\s+/)[0]!);
}

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This skill's Blender runs on Linux x64 only.");

const systemLibraries = JSON.parse(
  readFileSync(join(SKILL, "system-libs.json"), "utf8"),
) as SystemLibraries;
let installedTarget = false;
const work = mkdtempSync(join(tmpdir(), "bayma-platform-bpy-"));
try {
  rmSync(STAGING, { recursive: true, force: true });
  const app = join(STAGING, "app");
  const lib = join(STAGING, "lib");
  mkdirSync(app, { recursive: true });
  mkdirSync(lib);
  mkdirSync(join(STAGING, "user"));

  const tarball = join(work, basename(BLENDER.url));
  await fetchPinned(BLENDER.url, BLENDER.sha256, tarball);
  run(["tar", "-xJf", tarball, "-C", app, "--strip-components=1"]);
  rmSync(tarball);

  // Supply what this system lacks, and what that needs in turn.
  const supplied: string[] = [];
  for (let wanted = missing(join(app, "blender"), lib); wanted.length > 0;) {
    for (const soname of wanted) {
      const entry = systemLibraries.libraries.find((l) => l.soname === soname);
      if (!entry || supplied.includes(soname))
        throw new Error(
          `Blender needs ${soname}, which this skill cannot supply`,
        );
      const deb = join(work, basename(entry.filename));
      await fetchPinned(
        systemLibraries.mirror + entry.filename,
        entry.sha256,
        deb,
      );
      const unpacked = join(work, entry.package);
      mkdirSync(unpacked);
      unpackDeb(deb, unpacked);
      const libraries = join(unpacked, "usr", "lib", "x86_64-linux-gnu");
      for (const file of existsSync(libraries) ? readdirSync(libraries) : [])
        cpSync(join(libraries, file), join(lib, file), {
          verbatimSymlinks: true,
          recursive: true,
        });
      supplied.push(soname);
    }
    wanted = missing(join(app, "blender"), lib);
  }

  // Paths as they will be once STAGING becomes TARGET.
  const environment = {
    command: join(TARGET, "app", "blender"),
    env: {
      ...(supplied.length > 0 ? { LD_LIBRARY_PATH: join(TARGET, "lib") } : {}),
      // Blender's preferences, add-ons, and caches, kept in this folder.
      BLENDER_USER_RESOURCES: join(TARGET, "user"),
    },
  };
  writeFileSync(
    join(STAGING, "env.json"),
    JSON.stringify(environment, null, 2) + "\n",
  );

  rmSync(TARGET, { recursive: true, force: true });
  renameSync(STAGING, TARGET);
  installedTarget = true;

  // A tiny Cycles render proves Blender runs headless and renders.
  const frame = join(work, "check.png");
  const output = run(
    [
      environment.command,
      "-b",
      "--factory-startup",
      "--python-expr",
      [
        "import bpy",
        "scene = bpy.context.scene",
        "scene.render.engine = 'CYCLES'",
        "scene.cycles.samples = 4",
        "scene.render.resolution_x = scene.render.resolution_y = 32",
        `scene.render.filepath = ${JSON.stringify(frame)}`,
        "bpy.ops.render.render(write_still=True)",
        "print('BLENDER', bpy.app.version_string)",
      ].join("; "),
    ],
    { ...process.env, ...environment.env },
  );
  if (!existsSync(frame) || !output.includes("BLENDER "))
    throw new Error(`Blender did not render:\n${output}`);
  const size = run(["du", "-sh", TARGET]).split("\t")[0];
  console.log(
    `Installed Blender ${BLENDER.version} in ${TARGET} (${size})` +
      (supplied.length > 0 ? `, with ${supplied.join(", ")} supplied` : ""),
  );
} catch (error) {
  rmSync(STAGING, { recursive: true, force: true });
  // An install that fails its first render is no install.
  if (installedTarget) rmSync(TARGET, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(work, { recursive: true, force: true });
}
