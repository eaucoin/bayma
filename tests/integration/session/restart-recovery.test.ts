import { expect, test } from "bun:test";
import { EngineHarness } from "../../support/engine-harness.ts";

test("a restarted engine recovers a checkpointed session and its state", async () => {
  const first = await EngineHarness.launch({
    resolveCreatePolicy: () => ({
      durabilityMode: "checkpointed",
      bootstrapCode: "globalThis.answer = globalThis.$checkpoint?.answer ?? 0;",
    }),
  });
  try {
    const actor = first.actor();
    const { sessionId } = await actor.create("restart");
    await actor.run(
      sessionId,
      "globalThis.answer = 41; globalThis.$checkpoint = { answer: globalThis.answer };",
    );
    await actor.detach(sessionId);
    await actor.release();

    await first.stop();

    const restarted = await EngineHarness.launch({ stateDir: first.stateDir });
    try {
      const reconnect = restarted.actor();
      const listed = restarted.manager.list();
      expect(listed.map((session) => session.sessionId)).toContain(sessionId);
      await reconnect.attach(sessionId, "controller");
      const suspended = listed.find(
        (session) => session.sessionId === sessionId,
      );
      expect(suspended?.status).toBe("suspended");

      const exec = await reconnect.run(sessionId, "answer + 1");
      expect(exec.status).toBe("ok");
      expect(
        exec.messages.some(
          (message) => message.kind === "result" && message.text.includes("42"),
        ),
      ).toBe(true);
      await reconnect.release();
    } finally {
      await restarted.close();
    }
  } finally {
    await first.close();
  }
}, 10_000);
