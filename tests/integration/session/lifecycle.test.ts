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

test(
  "a REPL that exits while a process it spawned holds its stdio ends its exec at once, as its runtime having exited, with what it printed",
  async () => {
    await withEngine(async ({ harness, actor }) => {
      const { sessionId } = await actor.create("held stdio");
      const exec = await actor.run(
        sessionId,
        'const holder = Bun.spawn(["sleep", "30"]); console.log("HOLDER=" + holder.pid); process.exit(7)',
        2_000,
      );

      expect(exec.status).toBe("error");
      expect(exec.messages).toEqual([
        expect.objectContaining({
          kind: "stdout",
          text: expect.stringMatching(/^HOLDER=\d+\n$/),
        }),
        expect.objectContaining({
          kind: "error",
          text: expect.stringContaining(
            "exited unexpectedly (code=7, signal=none)",
          ),
        }),
      ]);
      expect(harness.manager.detail(sessionId).quarantineReason).toContain(
        "runtime process exited",
      );
    });
  },
  { timeout: 20_000 },
);
