import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

test("output deltas stream before the exec finishes", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("stream");
    const { execId } = await actor.submit(
      sessionId,
      'console.log("before"); await new Promise((resolve) => setTimeout(() => { console.log("after"); resolve(1); }, 50))',
    );

    const before = await actor.waitForEvent(
      (event) =>
        event.type === "exec/stdout" &&
        event.execId === execId &&
        event.text.includes("before"),
    );
    const finished = await actor.waitForEvent(
      (event) => event.type === "exec/finished" && event.execId === execId,
    );
    expect(actor.events.indexOf(before)).toBeLessThan(
      actor.events.indexOf(finished),
    );
  });
});
