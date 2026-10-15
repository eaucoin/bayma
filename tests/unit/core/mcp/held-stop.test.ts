import { afterEach, expect, test } from "bun:test";
import { HeldStop, markSandboxResumed, markSandboxSaved } from "@bayma/core";

// SIGTERM's stop, held for a save of the sandbox
// (packages/core/src/mcp/held-stop.ts).

afterEach(() => markSandboxResumed());

/** A held stop of `waitMs`, and what came of it: the server's sessions held and let go, and its stop. */
function heldStop(waitMs: number) {
  const happened: string[] = [];
  const stop = new HeldStop(
    waitMs,
    {
      holdStop: (reason) => happened.push(`held: ${reason}`),
      releaseStop: () => happened.push("released"),
    },
    () => happened.push("stopped"),
  );
  return { stop, happened };
}

test("without a wait, SIGTERM stops the server at once", () => {
  const { stop, happened } = heldStop(0);
  stop.begin();
  expect(happened).toEqual(["stopped"]);
});

test("a held stop holds the sessions, and goes on as its wait ends, once", async () => {
  const { stop, happened } = heldStop(50);
  stop.begin();
  stop.begin();
  expect(happened).toEqual([
    "held: the server is stopping: it holds its stop for up to 0.05 s for a save of its sandbox, and takes no new session or exec meanwhile",
  ]);
  expect(stop.holding).toBe(true);
  await Bun.sleep(100);
  expect(happened.slice(1)).toEqual(["stopped"]);
  expect(stop.holding).toBe(false);
});

test("a wait that ends during a save leaves the stop to the save's outcome: a restore lets it go, a resume goes on", async () => {
  const restored = heldStop(20);
  restored.stop.begin();
  markSandboxSaved();
  await Bun.sleep(60);
  expect(restored.happened.slice(1)).toEqual([]);
  restored.stop.restored();
  markSandboxResumed();
  await Bun.sleep(60);
  expect(restored.happened.slice(1)).toEqual(["released"]);

  const resumed = heldStop(20);
  resumed.stop.begin();
  markSandboxSaved();
  await Bun.sleep(60);
  expect(resumed.happened.slice(1)).toEqual([]);
  markSandboxResumed();
  resumed.stop.resumed();
  expect(resumed.happened.slice(1)).toEqual(["stopped"]);
});

test("sandbox-hook stop goes on at once; with no stop held, a restore, a resume and a stop do nothing", () => {
  const { stop, happened } = heldStop(60_000);
  stop.restored();
  stop.resumed();
  stop.goOn("asked");
  expect(happened).toEqual([]);
  stop.begin();
  stop.goOn("sandbox-hook stop asked it to");
  expect(happened.slice(1)).toEqual(["stopped"]);
});
