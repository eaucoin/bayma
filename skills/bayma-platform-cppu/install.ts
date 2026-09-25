// Installs LibreOffice into this skill's libreoffice/ folder: the official
// release and its SDK, unpacked from their Debian packages, and the C++
// headers of the whole office API, which the SDK's cppumaker generates from
// the office's type libraries. Then writes compile_flags.txt, with which a
// bayma C++ session in this folder compiles against those headers and loads
// the UNO runtime. Linux x64 only.
//
//   bun install.ts
//
// The office is LibreOffice's own build, made with GCC and libstdc++, so
// sessions compile with libstdc++ too.

import {
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

const VERSION = "26.8.0";
const RELEASE = `https://download.documentfoundation.org/libreoffice/stable/${VERSION}/deb/x86_64`;
const OFFICE: Pin = {
  url: `${RELEASE}/LibreOffice_${VERSION}_Linux_x86-64_deb.tar.gz`,
  sha256: "d0a6031a3837e48f9854e6d2da6489b9fadbd814afa4741fa32a197741663a22",
};
const SDK: Pin = {
  url: `${RELEASE}/LibreOffice_${VERSION}_Linux_x86-64_deb_sdk.tar.gz`,
  sha256: "a0f179295c24559d08d0241524cabe9772ae12e55ddf6cce121c88f326c32b4b",
};
// The office installs under /opt; this is its folder there.
const OFFICE_DIR = join("opt", "libreoffice26.8");

const SKILL = import.meta.dir;
const TARGET = join(SKILL, "libreoffice");
// Assembled beside TARGET, which it replaces only once it is complete.
const STAGING = `${TARGET}.partial`;
const COMPILE_FLAGS = join(SKILL, "compile_flags.txt");
const PROFILE = join(SKILL, "profile");

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

/** Unpacks a Debian package's files, which it carries as an xz tarball. */
function extractDeb(deb: string, destination: string): void {
  const archive = readFileSync(deb);
  let offset = 8; // "!<arch>\n"
  while (offset + 60 <= archive.length) {
    const name = archive.toString("latin1", offset, offset + 16).trim();
    const size = Number(archive.toString("latin1", offset + 48, offset + 58));
    const start = offset + 60;
    if (name.startsWith("data.tar.xz")) {
      const tarball = `${deb}.tar.xz`;
      writeFileSync(tarball, archive.subarray(start, start + size));
      run(["tar", "-xJf", tarball, "-C", destination]);
      rmSync(tarball);
      return;
    }
    offset = start + size + (size % 2);
  }
  throw new Error(`${deb} carries no data.tar.xz`);
}

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This skill's LibreOffice runs on Linux x64 only.");

const work = mkdtempSync(join(tmpdir(), "bayma-platform-cppu-"));
try {
  const tarballs = await Promise.all(
    [OFFICE, SDK].map((pin) => fetchPinned(pin, work)),
  );
  const unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  for (const tarball of tarballs) {
    run(["tar", "-xzf", tarball, "-C", work]);
    rmSync(tarball);
  }
  for (const release of readdirSync(work).filter((name) =>
    name.startsWith("LibreOffice_"),
  )) {
    const debs = join(work, release, "DEBS");
    for (const deb of readdirSync(debs).filter((name) => name.endsWith(".deb")))
      extractDeb(join(debs, deb), unpacked);
  }

  rmSync(STAGING, { recursive: true, force: true });
  renameSync(join(unpacked, OFFICE_DIR), STAGING);
  const program = join(STAGING, "program");
  // The C++ headers of every type the office's API has.
  run(
    [
      join(STAGING, "sdk", "bin", "cppumaker"),
      "-Gc",
      "-O",
      join(STAGING, "include"),
      join(program, "types.rdb"),
      join(program, "types", "offapi.rdb"),
    ],
    { LD_LIBRARY_PATH: program },
  );
  const probe = join(work, "profile");
  const version = run([
    join(program, "soffice.bin"),
    "--headless",
    "--version",
    `-env:UserInstallation=file://${probe}`,
  ]).trim();
  if (!version.startsWith(`LibreOffice ${VERSION}`))
    throw new Error(`The unpacked office reports "${version}"`);

  rmSync(TARGET, { recursive: true, force: true });
  renameSync(STAGING, TARGET);
  const installed = join(TARGET, "program");
  writeFileSync(
    COMPILE_FLAGS,
    [
      "-stdlib=libstdc++",
      "-std=gnu++17",
      "-DLINUX",
      "-DUNX",
      "-DCPPU_ENV=gcc3",
      `-DBAYMA_OFFICE_ROOT="${TARGET}"`,
      `-DBAYMA_OFFICE_PROFILE="${PROFILE}"`,
      "-isystem",
      join(TARGET, "sdk", "include"),
      "-isystem",
      join(TARGET, "include"),
      `-L${installed}`,
      // The UNO runtime, each library after the ones it needs.
      "-l:libuno_sal.so.3",
      "-l:libuno_cppu.so.3",
      "-l:libuno_salhelpergcc3.so.3",
      "-l:libuno_cppuhelpergcc3.so.3",
      "",
    ].join("\n"),
  );
  console.log(`Installed ${version} in ${TARGET}, and ${COMPILE_FLAGS}`);
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(STAGING, { recursive: true, force: true });
}
