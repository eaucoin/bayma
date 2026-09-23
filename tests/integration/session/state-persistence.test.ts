import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

test("state persists across execs in the same session", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("persist");

    await actor.run(sessionId, "const saved = 41");
    const exec = await actor.run(sessionId, "saved + 1");

    expect(exec.status).toBe("ok");
    expect(
      exec.messages.some(
        (message) => message.kind === "result" && message.text.includes("42"),
      ),
    ).toBe(true);
  });
});
