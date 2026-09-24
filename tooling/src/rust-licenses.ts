import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { ensureDir, walkFiles } from "./shared/files.ts";
import { runOrThrow } from "./shared/process.ts";

// Every crate linked into bayma-rust-host ships its license text with the
// host package. This is a legal artefact of the release, not build ceremony.

export interface RustLicenseInventoryEntry {
  name: string;
  version: string;
  license: string;
  authors: string[];
  repository?: string;
  licenseFiles: string[];
}

/** One crate whose license file is the canonical text per family. */
export const CANONICAL_LICENSE_SOURCES = {
  "0BSD": ["adler2", "LICENSE-0BSD"],
  "Apache-2.0": ["evcxr", "LICENSE"],
  "Apache-2.0 WITH LLVM-exception": [
    "wasi",
    "LICENSE-Apache-2.0_WITH_LLVM-exception",
  ],
  "BSL-1.0": ["ryu", "LICENSE-BOOST"],
  "CC0-1.0": ["notify", "LICENSE-CC0"],
  ISC: ["inotify", "LICENSE"],
  MIT: ["anyhow", "LICENSE-MIT"],
  "MPL-2.0": ["option-ext", "LICENSE.txt"],
  Unicode: ["icu_locale_core", "LICENSE"],
  Unlicense: ["aho-corasick", "UNLICENSE"],
  Zlib: ["foldhash", "LICENSE"],
} as const;

const LICENSE_FILE_NAME =
  /^(?:license|copying|unlicense|notices?|copyright)(?:[._-].*)?$/i;

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  authors: string[];
  repository: string | null;
  manifest_path: string;
}

interface CargoMetadata {
  packages: CargoPackage[];
  resolve: { nodes: { id: string; deps: { pkg: string }[] }[] };
}

/** The crates in the host's dependency closure, with where cargo has them. */
async function hostClosure(
  nativeRoot: string,
  host: string,
  cargo: string,
): Promise<Map<CargoPackage, string>> {
  const metadata = JSON.parse(
    (
      await runOrThrow(
        [
          cargo,
          "metadata",
          "--format-version",
          "1",
          "--locked",
          "--manifest-path",
          join(nativeRoot, "Cargo.toml"),
        ],
        {
          cwd: nativeRoot,
          // cargo finds rustc beside itself, never the machine's.
          env: { RUSTC: join(dirname(cargo), "rustc") },
        },
      )
    ).stdout,
  ) as CargoMetadata;
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const deps = new Map(
    metadata.resolve.nodes.map((node) => [
      node.id,
      node.deps.map((dep) => dep.pkg),
    ]),
  );
  const root = metadata.packages.find((pkg) => pkg.name === host);
  if (!root) throw new Error(`${host} is not in the cargo workspace`);
  const closure = new Map<CargoPackage, string>();
  const pending = [...(deps.get(root.id) ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const pkg = byId.get(id)!;
    if (closure.has(pkg)) continue;
    closure.set(pkg, dirname(pkg.manifest_path));
    pending.push(...(deps.get(id) ?? []));
  }
  return closure;
}

export async function collectLicenseInventory(
  nativeRoot: string,
  host: string,
  cargo: string,
): Promise<Map<RustLicenseInventoryEntry, string>> {
  const inventory = new Map<RustLicenseInventoryEntry, string>();
  const closure = [...(await hostClosure(nativeRoot, host, cargo))].sort(
    ([left], [right]) =>
      `${left.name}@${left.version}`.localeCompare(
        `${right.name}@${right.version}`,
      ),
  );
  for (const [pkg, crateRoot] of closure) {
    if (!pkg.license) {
      throw new Error(`crate ${pkg.name}@${pkg.version} declares no license`);
    }
    inventory.set(
      {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        authors: pkg.authors,
        ...(pkg.repository ? { repository: pkg.repository } : {}),
        licenseFiles: walkFiles(crateRoot)
          .map((path) => relative(crateRoot, path))
          .filter((path) => LICENSE_FILE_NAME.test(basename(path))),
      },
      crateRoot,
    );
  }
  if (inventory.size === 0) throw new Error("crate inventory is empty");
  return inventory;
}

function hasCanonicalText(expression: string): boolean {
  return Object.keys(CANONICAL_LICENSE_SOURCES).some((id) =>
    expression.toLowerCase().includes(id.toLowerCase()),
  );
}

/** Write the inventory and every license text under `licensesRoot`. */
export async function writeLicenseEvidence(
  licensesRoot: string,
  nativeRoot: string,
  host: string,
  cargo: string,
): Promise<void> {
  const inventory = await collectLicenseInventory(nativeRoot, host, cargo);
  const cratesRoot = join(licensesRoot, "crates");
  const commonRoot = join(licensesRoot, "common");
  ensureDir(cratesRoot);
  ensureDir(commonRoot);

  const crateRoots = new Map<string, string>();
  for (const [crate, crateRoot] of inventory) {
    if (!hasCanonicalText(crate.license)) {
      throw new Error(
        `crate ${crate.name}@${crate.version} has unsupported license expression ${crate.license}`,
      );
    }
    crateRoots.set(crate.name, crateRoot);
    for (const file of crate.licenseFiles) {
      const destination = join(
        cratesRoot,
        `${crate.name}-${crate.version}`,
        file,
      );
      ensureDir(dirname(destination));
      copyFileSync(join(crateRoot, file), destination);
    }
  }
  for (const [id, [crate, file]] of Object.entries(CANONICAL_LICENSE_SOURCES)) {
    const source = join(crateRoots.get(crate) ?? "", file);
    if (!crateRoots.has(crate) || !existsSync(source))
      throw new Error(`canonical license text missing for ${id}: ${source}`);
    copyFileSync(source, join(commonRoot, `${id}.txt`));
  }
  writeFileSync(
    join(licensesRoot, "README.txt"),
    [
      `This directory records the complete Cargo dependency inventory linked into ${host}.`,
      "inventory.json preserves each crate's name, version, SPDX expression, authors, repository, and notice filenames.",
      "crates/ carries every license, copying, notice, copyright, or unlicense file present in the crate as cargo fetched it.",
      "common/ supplies canonical texts for every license family in the inventory, including crates whose archive inherited a workspace license and shipped no license file.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(licensesRoot, "inventory.json"),
    JSON.stringify({ crates: [...inventory.keys()] }, null, 2) + "\n",
  );
}
