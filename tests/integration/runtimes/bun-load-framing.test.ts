import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFilePath } from "@bayma/core";
import { withEngine } from "../../support/engine-harness.ts";

test("a multiline submission is loaded from a file that is removed once the exec finishes", async () => {
  await withEngine(async ({ harness, actor }) => {
    const { sessionId } = await actor.create("multi");
    const { execId } = await actor.submit(
      sessionId,
      "const a = 40;\nconst b = 2;\nconsole.log(a + b);\na + b",
    );
    await actor.waitForExec(sessionId, execId);

    expect(
      existsSync(
        execFilePath(
          join(harness.stateDir, "execs"),
          sessionId,
          execId,
          "x.ts",
        ),
      ),
    ).toBe(false);
  });
});
