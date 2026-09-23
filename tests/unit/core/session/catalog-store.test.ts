import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionCatalogStore } from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

test("session metadata round-trips atomically", async () => {
  await withTempDir(async (dir) => {
    const store = new SessionCatalogStore(dir);
    store.write({
      sessionId: "sess_1",
      runtimeId: "bun",
      title: "title",
      cwd: dir,
      status: "suspended",
      durabilityMode: "checkpointed",
      bootstrapCode: "globalThis.answer = globalThis.$checkpoint?.answer ?? 0;",
      checkpointRevision: "ckpt_1",
      checkpointUpdatedAtMs: 2,
      runtimeGeneration: 1,
      createdAtMs: 1,
      updatedAtMs: 2,
      closed: false,
      cols: 80,
      rows: 24,
    });

    const catalogPath = store.entryPath("sess_1");
    const v0Catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete v0Catalog.schemaVersion;
    writeFileSync(catalogPath, JSON.stringify(v0Catalog), "utf8");

    writeFileSync(
      join(store.sessionsDir, "sess_1.json.tmp"),
      "{broken",
      "utf8",
    );
    const loaded = store.read("sess_1");
    expect(loaded?.sessionId).toBe("sess_1");
    expect(loaded?.closed).toBe(false);
    expect(loaded?.schemaVersion).toBe(2);

    writeFileSync(
      join(store.sessionsDir, "sess_corrupt.json"),
      "{broken",
      "utf8",
    );
    const listing = store.list();
    expect(listing.entries.map((entry) => entry.sessionId)).toEqual(["sess_1"]);
    expect(listing.failures).toEqual([
      expect.objectContaining({ sessionId: "sess_corrupt" }),
    ]);

    expect(() =>
      store.write({
        ...loaded!,
        sessionId: "sess_oversized_terminal",
        cols: 65_536,
      }),
    ).toThrow();
  });
});
