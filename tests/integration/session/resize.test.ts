import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withEngine } from "../../support/engine-harness.ts";

test("a resize reaches the active transport and is persisted", async () => {
  await withEngine(async ({ harness, actor }) => {
    const { sessionId } = await actor.create("resize");
    await actor.resize(sessionId, 132, 33);
    await actor.run(sessionId, "1 + 1");

    const metadata = JSON.parse(
      readFileSync(
        join(harness.stateDir, "sessions", `${sessionId}.json`),
        "utf8",
      ),
    );
    expect(metadata.cols).toBe(132);
    expect(metadata.rows).toBe(33);
  });
});
