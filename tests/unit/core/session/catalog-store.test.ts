import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SESSION_CATALOG_SCHEMA_VERSION,
  SessionCatalogStore,
  type ProcessSnapshot,
  type SessionCatalogWrite,
} from "@bayma/core";
import { withTempDir } from "../../../support/temp.ts";

function catalogEntry(dir: string): SessionCatalogWrite {
  return {
    sessionId: "sess_1",
    runtimeId: "bun",
    title: "title",
    cwd: dir,
    status: "suspended",
    durabilityMode: "checkpointed",
    bootstrapCode: "",
    checkpointRevision: "ckpt_1",
    checkpointUpdatedAtMs: 2,
    runtimeGeneration: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    closed: false,
    cols: 80,
    rows: 24,
  };
}

const processSnapshot: ProcessSnapshot = {
  pid: 4_100,
  maxPid: 4_132,
  stdio: ["pipe:[11]", "pipe:[12]", "pipe:[13]"],
  stdioFds: [0, 1, 2],
  bootId: "boot-1",
  baymaVersion: "9.9.9",
  createdAtMs: 3,
};

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
    expect(loaded?.schemaVersion).toBe(SESSION_CATALOG_SCHEMA_VERSION);

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

test("a version 2 entry reads as the current version, without a process snapshot", async () => {
  await withTempDir((dir) => {
    const store = new SessionCatalogStore(dir);
    store.write(catalogEntry(dir));
    const catalogPath = store.entryPath("sess_1");
    writeFileSync(
      catalogPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(catalogPath, "utf8")),
        schemaVersion: 2,
      }),
    );

    const loaded = store.read("sess_1");

    expect(loaded?.schemaVersion).toBe(SESSION_CATALOG_SCHEMA_VERSION);
    expect(loaded?.processSnapshot).toBeUndefined();
  });
});

test("a process snapshot round-trips with its session", async () => {
  await withTempDir((dir) => {
    const store = new SessionCatalogStore(dir);
    store.write({ ...catalogEntry(dir), processSnapshot });

    expect(store.read("sess_1")?.processSnapshot).toEqual(processSnapshot);
  });
});

test("a process snapshot an entry cannot hold is refused", async () => {
  await withTempDir((dir) => {
    const store = new SessionCatalogStore(dir);

    expect(() =>
      store.write({
        ...catalogEntry(dir),
        durabilityMode: "ephemeral",
        checkpointRevision: undefined,
        checkpointUpdatedAtMs: undefined,
        processSnapshot,
      }),
    ).toThrow("ephemeral catalog entries may not claim a process snapshot");
    expect(() =>
      store.write({
        ...catalogEntry(dir),
        processSnapshot: {
          ...processSnapshot,
          maxPid: processSnapshot.pid - 1,
        },
      }),
    ).toThrow("a process snapshot's highest PID precedes its root's");
  });
});
