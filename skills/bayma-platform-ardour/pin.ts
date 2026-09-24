// Pins what install.ts builds Ardour from and runs it with: the Ubuntu 24.04
// packages ROOTS names and everything they depend on, from the release
// pocket, which never changes, into packages.json.
//
//   bun pin.ts
//
// Only for changing what the skill pins; installing reads packages.json.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MIRROR = "http://archive.ubuntu.com/ubuntu/";

// Clang builds Ardour, as Ardour's own Linux builds are built, against
// libstdc++; the -dev packages are the libraries Ardour's engine is built
// with; the rest are the instruments and effects sessions use.
const ROOTS = [
  // The compiler and what it builds with.
  "clang-18",
  "lld-18",
  "llvm-18",
  "libc6-dev",
  "libstdc++-13-dev",
  "pkgconf",
  "bzip2",
  // Ardour's engine's libraries.
  "libboost-dev",
  "libglibmm-2.4-dev",
  "libsigc++-2.0-dev",
  "libcairomm-1.0-dev",
  "libpangomm-1.4-dev",
  "libsndfile1-dev",
  "libsamplerate0-dev",
  "libcurl4-gnutls-dev",
  "libarchive-dev",
  "liblo-dev",
  "libtag1-dev",
  "vamp-plugin-sdk",
  "librubberband-dev",
  "libusb-1.0-0-dev",
  "libasound2-dev",
  "libfftw3-dev",
  "libaubio-dev",
  "liblrdf0-dev",
  "libxml2-dev",
  "lv2-dev",
  "libserd-dev",
  "libsord-dev",
  "libsratom-dev",
  "liblilv-dev",
  "libogg-dev",
  "libflac-dev",
  "libreadline-dev",
  // What Ardour's configure checks for its user interface, which is not
  // built.
  "libcairo2-dev",
  "libpango1.0-dev",
  "libpng-dev",
  "libjpeg-dev",
  "libx11-dev",
  "libxext-dev",
  "libxrandr-dev",
  "libxinerama-dev",
  "libxi-dev",
  "libfontconfig-dev",
  // Instruments and effects.
  "avldrums.lv2",
  "calf-plugins",
  "guitarix-lv2",
];

// What those name that neither the build nor Ardour's engine uses:
// interpreters, tools, and a system's own configuration.
const SKIP =
  /^(python3.*|libpython3.*|perl.*|libperl.*|.*-perl|dpkg|debconf.*|bash|coreutils|sensible-utils|tzdata|install-info|ucf|adduser|passwd|login|init-system-helpers|lsb-base|x11-common|dbus.*|systemd.*|udev|libsystemd-shared|mime-support|media-types|netbase|readline-common|shared-mime-info|xdg-user-dirs|fontconfig-config|fonts-.*|gcc-.*-base|libglib2\.0-bin|libglib2\.0-data|libglib2\.0-dev-bin|bzip2-doc|sed|grep|findutils|diffutils|gir1\.2-.*|libc-dev-bin|libc-devtools|manpages.*|xz-utils|gzip|tar)$/;

interface Stanza {
  Package: string;
  Filename: string;
  SHA256: string;
  Depends?: string;
  "Pre-Depends"?: string;
  Provides?: string;
}

async function index(): Promise<Map<string, Stanza>> {
  const packages = new Map<string, Stanza>();
  for (const component of ["main", "universe"]) {
    const url = `${MIRROR}dists/noble/${component}/binary-amd64/Packages.xz`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`${url} answered HTTP ${response.status}`);
    const xz = Bun.spawnSync(["xz", "-dc"], {
      stdin: new Uint8Array(await response.arrayBuffer()),
    });
    if (xz.exitCode !== 0) throw new Error(`xz failed: ${xz.stderr}`);
    for (const block of xz.stdout.toString().split("\n\n")) {
      const fields: Record<string, string> = {};
      let key = "";
      for (const line of block.split("\n")) {
        if (line.startsWith(" ") && key) fields[key] += "\n" + line;
        else if (line.includes(":")) {
          key = line.slice(0, line.indexOf(":"));
          fields[key] = line.slice(line.indexOf(":") + 1).trim();
        }
      }
      if (fields.Package && !packages.has(fields.Package))
        packages.set(fields.Package, fields as unknown as Stanza);
    }
  }
  return packages;
}

const packages = await index();
const provides = new Map<string, string>();
// A virtual package's first provider stands for it.
for (const [name, stanza] of packages)
  for (const entry of (stanza.Provides ?? "").split(",")) {
    const provided = entry.split("(")[0]!.trim();
    if (provided && !provides.has(provided)) provides.set(provided, name);
  }

const chosen = new Map<string, Stanza>();
const queue = [...ROOTS];
while (queue.length > 0) {
  const name = queue.pop()!;
  if (chosen.has(name) || SKIP.test(name)) continue;
  const stanza = packages.get(name);
  if (!stanza) {
    const provider = provides.get(name);
    if (!provider) throw new Error(`Ubuntu 24.04 has no package ${name}`);
    queue.push(provider);
    continue;
  }
  chosen.set(name, stanza);
  for (const field of ["Depends", "Pre-Depends"] as const)
    for (const clause of (stanza[field] ?? "").split(",")) {
      const options = clause
        .split("|")
        .map((option) => option.split("(")[0]!.split(":")[0]!.trim())
        .filter(Boolean);
      if (options.length === 0 || options.some((option) => chosen.has(option)))
        continue;
      const pick =
        options.find((option) => packages.has(option)) ??
        options.map((option) => provides.get(option)).find(Boolean);
      if (!pick)
        throw new Error(`${name} needs ${clause}, which Ubuntu 24.04 lacks`);
      queue.push(pick);
    }
}

writeFileSync(
  join(import.meta.dir, "packages.json"),
  JSON.stringify(
    {
      "//": "Ubuntu 24.04 packages install.ts builds Ardour's engine with and runs it with: pin.ts's roots and what they depend on. The release pocket never changes, so each is pinned by its sha256.",
      mirror: MIRROR,
      packages: [...chosen.values()]
        .sort((a, b) => a.Package.localeCompare(b.Package))
        .map((stanza) => ({
          name: stanza.Package,
          filename: stanza.Filename,
          sha256: stanza.SHA256,
        })),
    },
    null,
    2,
  ) + "\n",
);
console.log(`pinned ${chosen.size} packages`);
