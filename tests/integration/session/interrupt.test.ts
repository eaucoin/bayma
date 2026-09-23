import { expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { withEngine } from "../../support/engine-harness.ts";

test(
  "interrupt stops the active exec without poisoning the session",
  async () => {
    await withEngine(
      async ({ actor }) => {
        const { sessionId } = await actor.create("interrupt");
        await actor.run(
          sessionId,
          "globalThis.keep = 41; globalThis.$checkpoint = { keep: globalThis.keep };",
        );

        const hanging = await actor.submit(
          sessionId,
          "await new Promise(() => {})",
        );
        await sleep(50);
        await actor.interrupt(sessionId);
        const interrupted = await actor.waitForExec(sessionId, hanging.execId);
        expect(interrupted.status).toBe("interrupted");
        expect(interrupted.interruptionReason).toBe("controller_request");

        const exec = await actor.run(sessionId, "keep + 1");
        expect(exec.status).toBe("ok");
        expect(
          exec.messages.some(
            (message) =>
              message.kind === "result" && message.text.includes("42"),
          ),
        ).toBe(true);
      },
      {
        resolveCreatePolicy: () => ({
          durabilityMode: "checkpointed",
          bootstrapCode: "globalThis.keep = globalThis.$checkpoint?.keep ?? 0;",
        }),
      },
    );
  },
  { timeout: 20_000 },
);
