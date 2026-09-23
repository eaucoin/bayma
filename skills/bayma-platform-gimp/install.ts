// Installs GIMP into this skill's gimp/ folder: GIMP's official Linux
// AppImage, unpacked, with the fonts GIMP uses and nothing from the machine's,
// the libgimp sources as reference, and env.json, the environment gimp_host.py
// runs headless GIMP with. Linux x64 only.
//
//   bun install.ts
//
// fonts.json chooses the fonts: Liberation, DejaVu, and Noto, with Noto CJK
// and Noto Color Emoji, always; the whole Google Fonts library, about 2.5 GB,
// when googleFonts is true.

import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

interface Pin {
  url: string;
  sha256: string;
}

const GIMP_VERSION = "3.2.6";
const APPIMAGE: Pin = {
  url: `https://download.gimp.org/gimp/v3.2/linux/GIMP-${GIMP_VERSION}-x86_64.AppImage`,
  sha256: "79ea41bc9b06f78fda181849a9ca8e42d83f1124dedb756f4d52352e2465010f",
};
const SOURCE: Pin = {
  url: `https://download.gimp.org/gimp/v3.2/gimp-${GIMP_VERSION}.tar.xz`,
  sha256: "40b15e90ad0c0c631b76da3c467ea9847fa5c24f37413ac5b492804860a28cd8",
};
// The fonts always installed: Noto from google/fonts at GOOGLE_FONTS_COMMIT,
// then Liberation's and DejaVu's releases.
const GOOGLE_FONTS_COMMIT = "b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04";
const CORE_FONTS: Pin[] = [
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf",
    sha256: "bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosans/NotoSans-Italic%5Bwdth%2Cwght%5D.ttf",
    sha256: "58e6e0ebd1931b29a365aa2d3e2ee9a9e831a3af7cf3ad1462d4e72154f0b291",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notoserif/NotoSerif%5Bwdth%2Cwght%5D.ttf",
    sha256: "4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notoserif/NotoSerif-Italic%5Bwdth%2Cwght%5D.ttf",
    sha256: "e87acbc6c0efd0d9a20d6a8cbbda2b266c14be3a3a6f5af8ec9d7b2460570ad1",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosansmono/NotoSansMono%5Bwdth%2Cwght%5D.ttf",
    sha256: "2cb2adb378a8f574213e23df697050b83c54c27df465a2015552740b2769a081",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notocoloremoji/NotoColorEmoji-Regular.ttf",
    sha256: "4d82a18d8d95f60ba883ce242bbadbf84a576e987745dd7ba38d71c67cff2d73",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
    sha256: "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    sha256: "050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf",
    sha256: "864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notoseriftc/NotoSerifTC%5Bwght%5D.ttf",
    sha256: "0077e18f57c6908f4a000969880940bdb0dad057c0e8d98b49dc364c3d1b09c6",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosanshk/NotoSansHK%5Bwght%5D.ttf",
    sha256: "76098ee78ec234cd4f8c950742b3f766fea2f8b43d5180d901048f4fc86c6849",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notoserifhk/NotoSerifHK%5Bwght%5D.ttf",
    sha256: "66108860e321aa413e7cb346448b4a418b779d94ae392accb32d163c024ae661",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf",
    sha256: "c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notoserifjp/NotoSerifJP%5Bwght%5D.ttf",
    sha256: "2fd527ba12b6a44ec30d796d633360da0aeba6c5d4af1304ce12bb4dc15a7dfc",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf",
    sha256: "194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252",
  },
  {
    url: "https://raw.githubusercontent.com/google/fonts/b5efa9c32e8f9b63005f5cdb1ad5527a77d2cd04/ofl/notoserifkr/NotoSerifKR%5Bwght%5D.ttf",
    sha256: "11f8d5de6f1b79195efba3828aaa2ec95c1178f5ae976fb23c8d53250a9938f3",
  },
  {
    url: "https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz",
    sha256: "7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0",
  },
  {
    url: "https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.tar.bz2",
    sha256: "fa9ca4d13871dd122f61258a80d01751d603b4d3ee14095d65453b4e846e17d7",
  },
];
// The families the core fonts must give GIMP.
const CORE_FAMILIES = [
  "Liberation Sans",
  "Liberation Serif",
  "Liberation Mono",
  "DejaVu Sans",
  "DejaVu Serif",
  "DejaVu Sans Mono",
  "Noto Sans",
  "Noto Serif",
  "Noto Sans Mono",
  "Noto Color Emoji",
  ...["SC", "TC", "HK", "JP", "KR"].flatMap((region) => [
    `Noto Sans ${region}`,
    `Noto Serif ${region}`,
  ]),
];

const SKILL = import.meta.dir;
const TARGET = join(SKILL, "gimp");
// Assembled beside TARGET, which it replaces only once it is complete.
const STAGING = `${TARGET}.partial`;

function run(
  command: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
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

/** Streams url to path, returning the SHA-256 of what arrived. */
async function download(url: string, path: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body)
    throw new Error(`${url} answered HTTP ${response.status}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as never);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(path));
  return hash.digest("hex");
}

async function fetchPinned(pin: Pin, path: string): Promise<string> {
  const digest = await download(pin.url, path);
  if (digest !== pin.sha256)
    throw new Error(`${pin.url} is not the pinned file (sha256 ${digest})`);
  return path;
}

function fontFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ttf|otf|ttc)$/i.test(path))
    .map((path) => join(directory, path));
}

/** The whole Google Fonts library at GOOGLE_FONTS_COMMIT, each file checked
 * against the commit's git blob hash. */
async function installGoogleFonts(
  work: string,
  fonts: string,
): Promise<number> {
  const listing = await fetch(
    `https://api.github.com/repos/google/fonts/git/trees/${GOOGLE_FONTS_COMMIT}?recursive=1`,
  );
  if (!listing.ok)
    throw new Error(
      `GitHub would not list google/fonts (HTTP ${listing.status})`,
    );
  const tree = (await listing.json()) as {
    truncated: boolean;
    tree: { path: string; sha: string }[];
  };
  if (tree.truncated) throw new Error("GitHub truncated the google/fonts tree");
  const blobs = new Map(tree.tree.map((entry) => [entry.path, entry.sha]));

  const tarball = join(work, "google-fonts.tar.gz");
  await download(
    `https://codeload.github.com/google/fonts/tar.gz/${GOOGLE_FONTS_COMMIT}`,
    tarball,
  );
  const unpacked = join(work, "google-fonts");
  mkdirSync(unpacked);
  // The commit holds its fonts as TrueType only, and tar fails on a pattern
  // nothing matches.
  run([
    "tar",
    "-xzf",
    tarball,
    "-C",
    unpacked,
    "--strip-components=1",
    "--wildcards",
    "*.ttf",
  ]);
  rmSync(tarball);
  const files = fontFiles(unpacked);
  for (const file of files) {
    const path = relative(unpacked, file);
    const bytes = readFileSync(file);
    const blob = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (blobs.get(path) !== blob)
      throw new Error(`google/fonts ${path} is not the file the commit holds`);
  }
  cpSync(unpacked, join(fonts, "google"), { recursive: true });
  return files.length;
}

/** The fontconfig configuration GIMP runs with: the skill's fonts only. */
function fontsConf(fonts: string, cache: string): string {
  const prefer = (families: string[]) =>
    families.map((family) => `<family>${family}</family>`).join("");
  const cjk = ["SC", "TC", "HK", "JP", "KR"];
  const alias = (generic: string, families: string[]) =>
    `  <alias binding="same"><family>${generic}</family><prefer>${prefer(families)}</prefer></alias>`;
  return [
    '<?xml version="1.0"?>',
    '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
    "<fontconfig>",
    `  <dir>${fonts}</dir>`,
    `  <cachedir>${cache}</cachedir>`,
    alias("sans-serif", [
      "Noto Sans",
      ...cjk.map((r) => `Noto Sans ${r}`),
      "Noto Color Emoji",
    ]),
    alias("serif", [
      "Noto Serif",
      ...cjk.map((r) => `Noto Serif ${r}`),
      "Noto Color Emoji",
    ]),
    alias("monospace", ["DejaVu Sans Mono", "Noto Sans Mono", "Noto Sans SC"]),
    alias("emoji", ["Noto Color Emoji"]),
    "</fontconfig>",
    "",
  ].join("\n");
}

/** The environment of GIMP's AppRun, which gimp_host.py starts GIMP with,
 * for the AppImage unpacked at stagedApp and to be installed at app. */
function gimpEnvironment(
  stagedApp: string,
  app: string,
  fontsConfPath: string,
  profile: string,
) {
  const libraries = join(app, "usr", "lib", "x86_64-linux-gnu");
  const preload = [
    join("usr", "lib"),
    join("usr", "lib64"),
    join("usr", "lib", "x86_64-linux-gnu"),
  ].flatMap((directory) =>
    readdirSync(join(stagedApp, directory))
      .filter((name) => /^lib(babl|gegl|gimp).*\.so/.test(name))
      .map((name) => join(app, directory, name)),
  );
  return {
    // The AppImage's programs name their dynamic loader relative to it.
    cwd: app,
    command: join(
      app,
      "usr",
      "bin",
      `gimp-console-${GIMP_VERSION.split(".").slice(0, 2).join(".")}`,
    ),
    env: {
      PATH: `${join(app, "usr", "bin")}:/usr/bin:/bin`,
      LD_PRELOAD: preload.join(":"),
      XDG_DATA_DIRS: join(app, "usr", "share"),
      GIO_MODULE_DIR: join(libraries, "gio", "modules"),
      GIO_EXTRA_MODULES: "",
      GDK_PIXBUF_MODULEDIR: join(
        libraries,
        "gdk-pixbuf-2.0",
        "2.10.0",
        "loaders",
      ),
      GDK_PIXBUF_MODULE_FILE: join(
        libraries,
        "gdk-pixbuf-2.0",
        "2.10.0",
        "loaders.cache",
      ),
      GI_TYPELIB_PATH: join(libraries, "girepository-1.0"),
      LIBHEIF_PLUGIN_PATH: join(libraries, "libheif", "plugins"),
      PYTHONDONTWRITEBYTECODE: "1",
      // As AppRun does: the AppImage's own libraries only.
      LD_LIBRARY_PATH: "",
      FONTCONFIG_FILE: fontsConfPath,
      GIMP3_DIRECTORY: profile,
    },
  };
}

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("This skill's GIMP runs on Linux x64 only.");
const settings = JSON.parse(
  readFileSync(join(SKILL, "fonts.json"), "utf8"),
) as {
  googleFonts: boolean;
};

let installedTarget = false;
const work = mkdtempSync(join(tmpdir(), "bayma-platform-gimp-"));
try {
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(STAGING);

  const appImage = await fetchPinned(
    APPIMAGE,
    join(work, basename(APPIMAGE.url)),
  );
  chmodSync(appImage, 0o755);
  run([appImage, "--appimage-extract"], { cwd: work });
  rmSync(appImage);
  renameSync(join(work, "squashfs-root"), join(STAGING, "app"));

  const source = await fetchPinned(SOURCE, join(work, basename(SOURCE.url)));
  const sourceRoot = `gimp-${GIMP_VERSION}`;
  const referenceDirs = [
    "libgimp",
    "libgimpbase",
    "libgimpcolor",
    "libgimpconfig",
    "libgimpmath",
    "plug-ins/python",
  ];
  run([
    "tar",
    "-xJf",
    source,
    "-C",
    work,
    ...referenceDirs.map((directory) => `${sourceRoot}/${directory}`),
  ]);
  for (const directory of referenceDirs)
    cpSync(
      join(work, sourceRoot, directory),
      join(STAGING, "reference", directory),
      {
        recursive: true,
      },
    );

  const fonts = join(STAGING, "fonts");
  const core = join(fonts, "core");
  mkdirSync(core, { recursive: true });
  for (const pin of CORE_FONTS) {
    const file = decodeURIComponent(basename(new URL(pin.url).pathname));
    await fetchPinned(pin, join(work, file));
    if (/\.tar\.(gz|bz2)$/.test(file)) {
      const unpacked = join(work, `${file}.d`);
      mkdirSync(unpacked);
      run(["tar", "-xf", join(work, file), "-C", unpacked]);
      for (const font of fontFiles(unpacked))
        cpSync(font, join(core, basename(font)));
    } else {
      renameSync(join(work, file), join(core, file));
    }
  }
  const googleFonts = settings.googleFonts
    ? await installGoogleFonts(work, fonts)
    : 0;

  // Paths as they will be once STAGING becomes TARGET.
  const installed = (path: string) => join(TARGET, relative(STAGING, path));
  writeFileSync(
    join(STAGING, "fonts.conf"),
    fontsConf(installed(fonts), installed(join(STAGING, "fontconfig-cache"))),
  );
  mkdirSync(join(STAGING, "profile"));
  const environment = gimpEnvironment(
    join(STAGING, "app"),
    installed(join(STAGING, "app")),
    installed(join(STAGING, "fonts.conf")),
    installed(join(STAGING, "profile")),
  );
  writeFileSync(
    join(STAGING, "env.json"),
    JSON.stringify(environment, null, 2) + "\n",
  );
  writeFileSync(join(STAGING, "fonts.json"), JSON.stringify(settings) + "\n");

  rmSync(TARGET, { recursive: true, force: true });
  renameSync(STAGING, TARGET);
  installedTarget = true;

  // The first start indexes GIMP's plug-ins and the fonts; it also proves GIMP
  // runs, and that it has the fonts it should.
  const listing = run(
    [
      environment.command,
      "-i",
      "--batch-interpreter=python-fu-eval",
      "-b",
      "import json; from gi.repository import Gimp; " +
        "print('FONTS ' + json.dumps([font.get_name() for font in Gimp.fonts_get_list('')]))",
      "--quit",
    ],
    { cwd: environment.cwd, env: { ...process.env, ...environment.env } },
  );
  const names = JSON.parse(
    listing
      .split("\n")
      .find((line) => line.startsWith("FONTS "))
      ?.slice(6) ?? "[]",
  ) as string[];
  const missing = CORE_FAMILIES.filter(
    (family) =>
      !names.some((name) => name === family || name.startsWith(`${family} `)),
  );
  if (missing.length > 0)
    throw new Error(`GIMP lacks fonts it should have: ${missing.join(", ")}`);
  const size = run(["du", "-sh", TARGET]).split("\t")[0];
  console.log(
    `Installed GIMP ${GIMP_VERSION} in ${TARGET} (${size}) with ${names.length} fonts` +
      (googleFonts
        ? `, ${googleFonts} font files of them from Google Fonts`
        : ""),
  );
} catch (error) {
  rmSync(STAGING, { recursive: true, force: true });
  // An install that fails its first start is no install.
  if (installedTarget) rmSync(TARGET, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(work, { recursive: true, force: true });
}
