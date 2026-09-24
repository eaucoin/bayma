import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  cacheRoot,
  claimScratchDirectory,
  payloadValue,
  ProcessTransport,
} from "@bayma/core";
import type { RuntimeTransport } from "@bayma/core";
import type { RuntimeCheckpointCodec } from "@bayma/core";

export const RUST_PROMPT = "BAYMA> ";
export const RUST_CHECKPOINT_CODEC = {
  codecId: "rust-serde-json-v1",
  codecVersion: 1,
  payloadKind: "text-sidecar",
} as const satisfies RuntimeCheckpointCodec;

// EVcxR compiles its initial context. A finite guard covers the measured
// cold-start tail while retaining an honest terminal failure for a host that
// never becomes ready.
const RUST_STARTUP_TIMEOUT_MS = 60_000;

export function createRustTransport(): RuntimeTransport {
  const root = join(cacheRoot(), "rust");
  const scratchDir = claimScratchDirectory(join(root, "scratch"));
  return new ProcessTransport({
    platformId: "stdio",
    promptRe: /(?:^|[\r\n])BAYMA> /g,
    interruptStrategy: "recycle",
    ownsProcessTree: true,
    promptTimeoutMs: RUST_STARTUP_TIMEOUT_MS,
    command: () => {
      // EVcxR's compilation cache is content-addressed; one per toolchain.
      const version = process.env.BAYMA_RUST_VERSION ?? "development";
      const cacheDir = join(root, `evcxr-${version}`);
      const configDir = join(root, "config");
      const cargoHome = join(root, `cargo-home-${version}`);
      mkdirSync(cacheDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      seedCargoHome(cargoHome, process.env.BAYMA_RUST_CARGO_SEED_DIR);
      return {
        file: payloadValue("BAYMA_RUST_HOST_BIN"),
        args: [],
        env: {
          EVCXR_CONFIG_DIR: configDir,
          CARGO_HOME: cargoHome,
          BAYMA_RUST_CACHE_DIR: cacheDir,
          BAYMA_RUST_OWNS_PROCESS_TREE: "1",
          // EVcxR builds each session in a temporary crate that only its own
          // graceful exit removes; a host killed mid-cell leaves it behind.
          TMPDIR: scratchDir,
        },
      };
    },
  });
}

/**
 * The file naming the seed a Cargo home last received. It is written last, so
 * its presence proves a whole seed.
 */
export const CARGO_SEED_ID = "bayma-seed-id";

/**
 * The payload carries a Cargo registry seed: the support crate's dependency
 * closure and every crate the toolbelt's lockfile names, so cells compile and
 * the toolbelt resolves without network access. A new Cargo home receives the
 * whole seed; one an earlier payload seeded receives what this seed adds, and
 * keeps every crate its cells fetched since.
 */
export function seedCargoHome(
  cargoHome: string,
  seed: string | undefined,
): void {
  if (existsSync(cargoHome)) {
    if (seed && readSeedId(seed) !== readSeedId(cargoHome)) {
      mergeMissing(seed, cargoHome);
      copyFileSync(join(seed, CARGO_SEED_ID), join(cargoHome, CARGO_SEED_ID));
    }
    return;
  }
  mkdirSync(join(cargoHome, ".."), { recursive: true });
  const staging = mkdtempSync(`${cargoHome}.`);
  try {
    if (seed) cpSync(seed, staging, { recursive: true, force: true });
    renameSync(staging, cargoHome);
  } catch (error) {
    if (!existsSync(cargoHome)) throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function readSeedId(directory: string): string | undefined {
  try {
    return readFileSync(join(directory, CARGO_SEED_ID), "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Copy every file `from` holds and `to` lacks. Each lands by rename, so a
 * Cargo running in another session never reads a partial archive.
 */
function mergeMissing(from: string, to: string): void {
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(destination, { recursive: true });
      mergeMissing(source, destination);
    } else if (!existsSync(destination)) {
      const staging = `${destination}.${process.pid}`;
      copyFileSync(source, staging);
      renameSync(staging, destination);
    }
  }
}
