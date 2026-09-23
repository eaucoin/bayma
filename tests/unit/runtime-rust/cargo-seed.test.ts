import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CARGO_SEED_ID, seedCargoHome } from "@bayma/runtime-rust";
import { withTempDir } from "../../support/temp.ts";

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
}

const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

test("a new Cargo home receives the whole seed", async () => {
  await withTempDir((dir) => {
    const seed = join(dir, "seed");
    writeFiles(seed, {
      [CARGO_SEED_ID]: "one\n",
      "registry/cache/serde-1.crate": "serde",
    });
    const home = join(dir, "cargo-home");

    seedCargoHome(home, seed);

    expect(read(home, "registry/cache/serde-1.crate")).toBe("serde");
    expect(read(home, CARGO_SEED_ID)).toBe("one\n");
  });
});

test("an earlier seed's Cargo home gains the new seed's files and keeps its own", async () => {
  await withTempDir((dir) => {
    const home = join(dir, "cargo-home");
    writeFiles(home, {
      [CARGO_SEED_ID]: "one\n",
      "registry/cache/serde-1.crate": "serde",
      "registry/cache/fetched-by-a-cell-1.crate": "fetched",
    });
    const seed = join(dir, "seed");
    writeFiles(seed, {
      [CARGO_SEED_ID]: "two\n",
      "registry/cache/serde-1.crate": "serde from the new seed",
      "registry/cache/gix-1.crate": "gix",
      "registry/index/.cache/gi/x/gix": "index entry",
    });

    seedCargoHome(home, seed);

    expect(read(home, "registry/cache/gix-1.crate")).toBe("gix");
    expect(read(home, "registry/index/.cache/gi/x/gix")).toBe("index entry");
    // Existing files are never replaced, and cells' own crates stay.
    expect(read(home, "registry/cache/serde-1.crate")).toBe("serde");
    expect(read(home, "registry/cache/fetched-by-a-cell-1.crate")).toBe(
      "fetched",
    );
    expect(read(home, CARGO_SEED_ID)).toBe("two\n");
  });
});

test("a Cargo home that already holds this seed is left as it is", async () => {
  await withTempDir((dir) => {
    const home = join(dir, "cargo-home");
    writeFiles(home, { [CARGO_SEED_ID]: "two\n" });
    const seed = join(dir, "seed");
    writeFiles(seed, {
      [CARGO_SEED_ID]: "two\n",
      "registry/cache/gix-1.crate": "gix",
    });

    seedCargoHome(home, seed);

    expect(() => read(home, "registry/cache/gix-1.crate")).toThrow();
  });
});
