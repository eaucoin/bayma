// Installs MLT into this skill's mlt/ folder: the MLT++ and MLT headers from
// MLT's source release, and the libraries, modules, and data from Shotcut's
// portable Linux build, which carries MLT with FFmpeg and the libraries they
// use. Linux x64 only.
//
//   bun install.ts
//
// mlt/lib holds only what MLT++ and the modules in mlt/modules need, and
// mlt/libraries.txt lists it in an order that loads each library after the
// ones it needs, since their search paths name the machine Shotcut was built
// on.

import {
  cpSync,
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

interface Pin {
  url: string;
  sha256: string;
}

const SHOTCUT: Pin = {
  url: "https://github.com/mltframework/shotcut/releases/download/v26.8.1/shotcut-linux-x86_64-26.8.1.txz",
  sha256: "c4befab2240964389df6139f00aae0b92949f398fd98083b922f3aabd8b7a844",
};
const MLT_SOURCE: Pin = {
  url: "https://github.com/mltframework/mlt/releases/download/v7.40.0/mlt-7.40.0.tar.gz",
  sha256: "f11c30e21670f62a3dfc56a31306ac02f3feea00908a2821a4a0bf3e989d3d6a",
};
// Shotcut takes VA-API from the system, which a server may not have; these
// are Ubuntu 22.04's, which need no newer glibc than 2.34.
const LIBVA: Pin[] = [
  {
    url: "http://archive.ubuntu.com/ubuntu/pool/universe/libv/libva/libva2_2.14.0-1_amd64.deb",
    sha256: "30da2b3d7c066137116cb0c69c68d2709e6352bea0706ae54fadb89af24463fb",
  },
  {
    url: "http://archive.ubuntu.com/ubuntu/pool/universe/libv/libva/libva-drm2_2.14.0-1_amd64.deb",
    sha256: "c409075cc49011919d364cd20a729d02a212fb86fbd617146b47e2243e5ec318",
  },
  {
    url: "http://archive.ubuntu.com/ubuntu/pool/universe/libv/libva/libva-x11-2_2.14.0-1_amd64.deb",
    sha256: "e9331395732187e39117102f0811b1c49b554e8c8b5e50a46788f991b19aa8e9",
  },
];

const TARGET = join(import.meta.dir, "mlt");
// Assembled beside TARGET, which it replaces only once it is complete.
const STAGING = `${TARGET}.partial`;

function run(command: string[], env?: Record<string, string>): string {
  const result = Bun.spawnSync(command, {
    env: { ...process.env, ...env },
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")} failed: ${result.stderr}`);
  return result.stdout.toString();
}

async function fetchPinned(pin: Pin, directory: string): Promise<string> {
  const response = await fetch(pin.url);
  if (!response.ok)
    throw new Error(`${pin.url} answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== pin.sha256)
    throw new Error(`${pin.url} is not the pinned file (sha256 ${digest})`);
  const path = join(directory, basename(pin.url));
  writeFileSync(path, bytes);
  return path;
}

/** Unpacks a Debian package's files, which it carries as a zstd tarball. */
function extractDeb(deb: string, destination: string): void {
  const archive = readFileSync(deb);
  let offset = 8; // "!<arch>\n"
  while (offset + 60 <= archive.length) {
    const name = archive.toString("latin1", offset, offset + 16).trim();
    const size = Number(archive.toString("latin1", offset + 48, offset + 58));
    const start = offset + 60;
    if (name.startsWith("data.tar.zst")) {
      const tarball = `${deb}.tar`;
      writeFileSync(
        tarball,
        Bun.zstdDecompressSync(archive.subarray(start, start + size)),
      );
      run(["tar", "-xf", tarball, "-C", destination]);
      return;
    }
    offset = start + size + (size % 2);
  }
  throw new Error(`${deb} carries no data.tar.zst`);
}

/** The bundled libraries a library loads, by the names it asks for them by. */
function bundledNeeds(library: string, bundle: string): string[] {
  return run(["ldd", library], { LD_LIBRARY_PATH: bundle })
    .split("\n")
    .flatMap((line) => {
      const [name, , path] = line.trim().split(/\s+/);
      return path?.startsWith(`${bundle}/`) ? [name] : [];
    });
}

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This skill's MLT runs on Linux x64 only.");

const work = mkdtempSync(join(tmpdir(), "bayma-platform-mltpp-"));
try {
  const [shotcut, source, ...debs] = await Promise.all(
    [SHOTCUT, MLT_SOURCE, ...LIBVA].map((pin) => fetchPinned(pin, work)),
  );
  run([
    "tar",
    "-xJf",
    shotcut,
    "-C",
    work,
    "--wildcards",
    "Shotcut.app/lib/*.so*",
    "Shotcut.app/share/mlt-7/*",
  ]);
  const bundle = join(work, "Shotcut.app", "lib");
  const debFiles = join(work, "deb");
  mkdirSync(debFiles);
  for (const deb of debs) extractDeb(deb, debFiles);
  cpSync(join(debFiles, "usr", "lib", "x86_64-linux-gnu"), bundle, {
    recursive: true,
    verbatimSymlinks: true,
  });

  // The modules whose libraries the bundle carries, leaving out Qt's.
  const moduleDir = join(bundle, "mlt-7");
  const modules = readdirSync(moduleDir).filter((module) => {
    const needs = run(["ldd", join(moduleDir, module)], {
      LD_LIBRARY_PATH: bundle,
    });
    return !needs.includes("not found") && !needs.includes("libQt6");
  });
  const libraries = new Set(["libmlt++-7.so.7"]);
  for (const library of [
    join(bundle, "libmlt++-7.so.7"),
    ...modules.map((module) => join(moduleDir, module)),
  ])
    for (const name of bundledNeeds(library, bundle)) libraries.add(name);
  // A library needs only libraries that need fewer than it does.
  const order = [...libraries]
    .map((name) => ({
      name,
      needs: bundledNeeds(join(bundle, name), bundle).length,
    }))
    .sort((a, b) => a.needs - b.needs)
    .map(({ name }) => name);

  rmSync(STAGING, { recursive: true, force: true });
  for (const name of order)
    cpSync(join(bundle, name), join(STAGING, "lib", name), {
      dereference: true,
    });
  for (const module of modules)
    cpSync(join(moduleDir, module), join(STAGING, "modules", module));
  cpSync(join(work, "Shotcut.app", "share", "mlt-7"), join(STAGING, "data"), {
    recursive: true,
  });
  writeFileSync(join(STAGING, "libraries.txt"), order.join("\n") + "\n");

  run([
    "tar",
    "-xzf",
    source,
    "-C",
    work,
    "--wildcards",
    "*/src/framework/*.h",
    "*/src/mlt++/*.h",
  ]);
  const headers = join(work, basename(MLT_SOURCE.url, ".tar.gz"), "src");
  for (const part of ["framework", "mlt++"])
    cpSync(join(headers, part), join(STAGING, "include", part), {
      recursive: true,
    });
  // MLT++ names MLT's header as installed under an include path; the skill's
  // headers are included by path instead.
  const mltpp = join(STAGING, "include", "mlt++");
  for (const header of readdirSync(mltpp)) {
    const path = join(mltpp, header);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll(
        "#include <framework/mlt.h>",
        '#include "../framework/mlt.h"',
      ),
    );
  }
  // MLT's build generates this; it is what code using MLT sees.
  writeFileSync(
    join(STAGING, "include", "framework", "mlt_export.h"),
    [
      "#ifndef MLT_EXPORT_H",
      "#define MLT_EXPORT_H",
      '#define MLT_EXPORT __attribute__((visibility("default")))',
      "#define MLT_DEPRECATED __attribute__((__deprecated__))",
      "#define MLT_DEPRECATED_EXPORT MLT_EXPORT MLT_DEPRECATED",
      "#endif",
      "",
    ].join("\n"),
  );
  rmSync(TARGET, { recursive: true, force: true });
  renameSync(STAGING, TARGET);
  console.log(
    `Installed MLT with ${order.length} libraries and ${modules.length} modules in ${TARGET}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(STAGING, { recursive: true, force: true });
}
