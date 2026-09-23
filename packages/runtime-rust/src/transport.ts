import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { cacheRoot, ProcessTransport } from "@bayma/core";
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

/**
 * One scratch root per server process, so leftovers from hosts that did not
 * exit gracefully are swept the next time a server starts: any sibling root
 * whose owning process is gone is removed.
 */
function claimScratchDirectory(root: string): string {
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || processIsAlive(pid))
      continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
  const own = join(root, String(process.pid));
  mkdirSync(own, { recursive: true });
  return own;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every runtime path comes from the payload environment, never PATH. */
function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set; the payload is not resolved`);
  return value;
}

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
      seedCargoHome(cargoHome);
      return {
        file: required("BAYMA_RUST_HOST_BIN"),
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
 * The payload carries the support crate's dependency closure, so the first
 * cell on a machine compiles without network access. The seed is copied once
 * into a writable Cargo home that later cells extend.
 */
function seedCargoHome(cargoHome: string): void {
  if (existsSync(cargoHome)) return;
  const seed = process.env.BAYMA_RUST_CARGO_SEED_DIR;
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
