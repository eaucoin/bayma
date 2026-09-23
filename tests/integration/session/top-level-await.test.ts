import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

test("top-level await completes only after the promise settles", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("await");
    const { execId } = await actor.submit(
      sessionId,
      'await new Promise((resolve) => setTimeout(() => { console.log("settled"); resolve(42); }, 50))',
    );

    const line = await actor.waitForEvent(
      (event) =>
        event.type === "exec/stdout" &&
        event.execId === execId &&
        event.text.includes("settled"),
      10_000,
    );
    const finished = await actor.waitForEvent(
      (event) => event.type === "exec/finished" && event.execId === execId,
      10_000,
    );
    expect(actor.events.indexOf(line)).toBeLessThan(
      actor.events.indexOf(finished),
    );
  });
}, 15_000);
