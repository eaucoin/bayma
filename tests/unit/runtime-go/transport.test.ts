import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createGoTransport, goHostModules } from "@bayma/runtime-go";
import { withTempDir } from "../../support/temp.ts";

test("an ended Go host leaves its own modules, by its pid, and no other's", () =>
  withTempDir((scratch) => {
    for (const name of ["41-0a1b", "410-2c3d", "4-4e5f", "42-6a7b"])
      mkdirSync(join(scratch, "go", name), { recursive: true });
    expect(goHostModules(scratch, 41)).toEqual([
      join(scratch, "go", "41-0a1b"),
    ]);
    // The transport names them to the server.
    expect(
      createGoTransport().endedHostFiles?.(scratch, {
        sessionId: "sess_go",
        platformId: "stdio",
        pid: 42,
        cols: 80,
        rows: 24,
      }),
    ).toEqual([join(scratch, "go", "42-6a7b")]);
  }));

test("a Go host that made no module leaves none", () =>
  withTempDir((scratch) => {
    expect(goHostModules(scratch, 41)).toEqual([]);
  }));
