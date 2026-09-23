import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A local Cargo registry, served from a git index over file://, in which one
// crate's locked version has since been yanked in favour of a newer one: the
// case only a lockfile can still resolve. Nothing touches the network.

export const FIXTURE_REGISTRY = "fixture";
export const FIXTURE_CRATE = "fixture_pick";
export const LOCKED_VERSION = "1.0.0";
export const NEWER_VERSION = "1.1.0";

export interface CargoRegistryFixture {
  /** Value for `CARGO_REGISTRIES_FIXTURE_INDEX`. */
  indexUrl: string;
  /** A Cargo.lock pinning the now-yanked `LOCKED_VERSION`. */
  lockfile: string;
  /** The `:dep` value that selects the fixture crate. */
  dependency: string;
}

function run(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  execFileSync(file, args, { cwd, env, stdio: "pipe" });
}

export function createCargoRegistryFixture(root: string): CargoRegistryFixture {
  const cargo = process.env.BAYMA_CARGO_BIN;
  if (!cargo)
    throw new Error("BAYMA_CARGO_BIN is not set; the payload is not resolved");
  const indexDir = join(root, "index");
  const downloads = join(root, "dl");
  const indexUrl = `file://${indexDir}`;
  const env = {
    ...process.env,
    CARGO_HOME: join(root, "cargo-home"),
    CARGO_REGISTRIES_FIXTURE_INDEX: indexUrl,
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const dependency = `{ version = "1", registry = "${FIXTURE_REGISTRY}" }`;

  const checksums = new Map<string, string>();
  mkdirSync(downloads, { recursive: true });
  for (const version of [LOCKED_VERSION, NEWER_VERSION]) {
    const source = join(root, `${FIXTURE_CRATE}-${version}`);
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(
      join(source, "Cargo.toml"),
      `[package]\nname = "${FIXTURE_CRATE}"\nversion = "${version}"\nedition = "2021"\ndescription = "fixture"\nlicense = "MIT"\n`,
    );
    writeFileSync(
      join(source, "src", "lib.rs"),
      `pub const VERSION: &str = "${version}";\n`,
    );
    run(
      cargo,
      ["package", "--quiet", "--no-verify", "--allow-dirty"],
      source,
      env,
    );
    const archive = join(downloads, `${FIXTURE_CRATE}-${version}.crate`);
    copyFileSync(
      join(source, "target", "package", `${FIXTURE_CRATE}-${version}.crate`),
      archive,
    );
    checksums.set(
      version,
      createHash("sha256").update(readFileSync(archive)).digest("hex"),
    );
  }

  const entry = (version: string, yanked: boolean) =>
    JSON.stringify({
      name: FIXTURE_CRATE,
      vers: version,
      deps: [],
      cksum: checksums.get(version),
      features: {},
      yanked,
    });
  const entryDir = join(
    indexDir,
    FIXTURE_CRATE.slice(0, 2),
    FIXTURE_CRATE.slice(2, 4),
  );
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(
    join(indexDir, "config.json"),
    `${JSON.stringify({ dl: `file://${downloads}/{crate}-{version}.crate` })}\n`,
  );
  run("git", ["init", "--quiet"], indexDir, env);

  // Publish only the locked version and lock a consumer against it.
  writeFileSync(
    join(entryDir, FIXTURE_CRATE),
    `${entry(LOCKED_VERSION, false)}\n`,
  );
  run("git", ["add", "--all"], indexDir, env);
  run("git", ["commit", "--quiet", "--message", "publish"], indexDir, env);
  const consumer = join(root, "consumer");
  mkdirSync(join(consumer, "src"), { recursive: true });
  writeFileSync(
    join(consumer, "Cargo.toml"),
    `[package]\nname = "consumer"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\n${FIXTURE_CRATE} = ${dependency}\n`,
  );
  writeFileSync(join(consumer, "src", "lib.rs"), "");
  run(cargo, ["generate-lockfile", "--quiet"], consumer, env);

  // Then yank it and publish a newer compatible release.
  writeFileSync(
    join(entryDir, FIXTURE_CRATE),
    `${entry(LOCKED_VERSION, true)}\n${entry(NEWER_VERSION, false)}\n`,
  );
  run(
    "git",
    ["commit", "--quiet", "--all", "--message", "yank and publish"],
    indexDir,
    env,
  );

  return { indexUrl, lockfile: join(consumer, "Cargo.lock"), dependency };
}
