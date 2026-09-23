import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

test("session pressure warnings and evictions reach observers", async () => {
  await withEngine(
    async ({ harness, actor }) => {
      const observer = harness.actor();
      try {
        const s1 = await actor.create("s1");
        await observer.attach(s1.sessionId, "observer");
        await actor.detach(s1.sessionId);

        const s2 = await actor.create("s2");
        await actor.detach(s2.sessionId);

        await actor.create("s3");

        const warning = await observer.waitForEvent(
          (event) => event.type === "session/pressureWarning",
        );
        const evicted = await observer.waitForEvent(
          (event) =>
            event.type === "session/closed" && event.sessionId === s1.sessionId,
        );
        expect(warning.type).toBe("session/pressureWarning");
        expect(evicted.type).toBe("session/closed");
      } finally {
        await observer.release();
      }
    },
    { maxSessions: 2, warnUsagePercent: 50 },
  );
});
