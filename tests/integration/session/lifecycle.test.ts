import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

test(
  "a client can create, attach, detach, reattach, and list sessions",
  async () => {
    await withEngine(async ({ harness, actor }) => {
      const { sessionId } = await actor.create("alpha");

      const observer = harness.actor();
      try {
        await observer.attach(sessionId, "observer");
        expect(
          harness.manager.list().map((session) => session.sessionId),
        ).toContain(sessionId);

        await observer.detach(sessionId);
        await observer.attach(sessionId, "observer");
      } finally {
        await observer.release();
      }
    });
  },
  { timeout: 20_000 },
);
