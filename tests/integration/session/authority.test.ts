import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

async function expectControllerLeaseError(
  promise: Promise<unknown>,
): Promise<void> {
  try {
    await promise;
    throw new Error("expected observer write request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "write action requires controller lease",
    );
  }
}

test("observers cannot mutate a session but still observe its execs", async () => {
  await withEngine(async ({ harness, actor }) => {
    const { sessionId } = await actor.create("authority");
    const observer = harness.actor();
    try {
      await observer.attach(sessionId, "observer");
      await expectControllerLeaseError(observer.submit(sessionId, "1 + 1"));
      await expectControllerLeaseError(observer.interrupt(sessionId));
      await expectControllerLeaseError(observer.resize(sessionId, 100, 40));

      const { execId } = await actor.submit(sessionId, "1 + 1");
      const observed = await observer.waitForEvent(
        (event) => event.type === "exec/finished" && event.execId === execId,
      );
      expect(observed.type).toBe("exec/finished");
    } finally {
      await observer.release();
    }
  });
}, 15_000);
