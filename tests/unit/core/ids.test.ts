import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SessionManager,
  SessionCatalogStore,
  ExecHistoryStore,
  CheckpointStore,
  createOpaqueId,
  RuntimeRegistry,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../support/fake-transport.ts";
import { withTempDir } from "../../support/temp.ts";

test("id scope rules are enforced", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const manager = new SessionManager(
      new RuntimeRegistry([{ adapter: bunAdapter, transport: transport }]),
      new SessionCatalogStore(dir),
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
      {
        maxSessions: 8,
        warnUsagePercent: 75,
        defaultCols: 80,
        defaultRows: 24,
      },
      () => undefined,
    );

    const one = await manager.create("conn_a", "one", dir, "controller");
    const two = await manager.create("conn_b", "two", dir, "controller");
    expect(one.sessionId).not.toBe(two.sessionId);
    expect(one.sessionId).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(two.sessionId).toMatch(/^sess_[0-9a-f]{32}$/);

    const first = await manager.submitExec(one.sessionId, "conn_a", "1 + 1");
    const second = await manager.submitExec(one.sessionId, "conn_a", "2 + 2");
    expect(first.execId).not.toBe(second.execId);
    expect(first.execId).toMatch(/^exec_[0-9a-f]{32}$/);
    expect(second.execId).toMatch(/^exec_[0-9a-f]{32}$/);
  });
});

test("opaque IDs retain full UUID entropy under one canonical format", () => {
  const ids = Array.from({ length: 1_000 }, () => createOpaqueId("scope"));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => /^scope_[0-9a-f]{32}$/.test(id))).toBe(true);
  expect(() => createOpaqueId("../scope")).toThrow("invalid opaque ID prefix");
  expect(() => createOpaqueId("a".repeat(96))).toThrow(
    "invalid opaque ID prefix",
  );
  expect(createOpaqueId("a".repeat(95))).toHaveLength(128);
});

test("persisted session IDs cannot escape state store directories", async () => {
  await withTempDir((dir) => {
    const sentinel = join(dir, "sentinel.txt");
    writeFileSync(sentinel, "keep\n", "utf8");
    const stores = [
      new SessionCatalogStore(dir),
      new ExecHistoryStore(dir),
      new CheckpointStore(dir),
    ];

    expect(() => stores[0]!.remove("..")).toThrow(
      "invalid persisted session ID",
    );
    expect(() => stores[1]!.remove("..")).toThrow(
      "invalid persisted session ID",
    );
    expect(() => stores[2]!.remove("..")).toThrow(
      "invalid persisted session ID",
    );
    expect(existsSync(sentinel)).toBe(true);
  });
});
