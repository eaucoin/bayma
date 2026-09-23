import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

function texts(
  exec: { messages: Array<{ kind: string; text: string }> },
  kind: string,
) {
  return exec.messages
    .filter((message) => message.kind === kind)
    .map((message) => message.text);
}

test("the result channel suppresses undefined", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("result-undefined");
    const exec = await actor.run(sessionId, 'console.log("visible")\nvoid 0');
    expect(exec.status).toBe("ok");
    expect(texts(exec, "stdout")).toEqual(["visible\n"]);
    expect(exec.messages.some((message) => message.kind === "result")).toBe(
      false,
    );
  });
});

test("the error channel separates thrown errors from results", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("result-error");
    const exec = await actor.run(sessionId, 'throw new Error("boom")');
    expect(exec.status).toBe("error");
    expect(
      exec.messages.some(
        (message) => message.kind === "error" && message.text.includes("boom"),
      ),
    ).toBe(true);
    expect(exec.messages.some((message) => message.kind === "result")).toBe(
      false,
    );
  });
});

test("Bun stdout preserves UTF-8 split across byte writes", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("split-utf8-output");
    const exec = await actor.run(
      sessionId,
      "process.stdout.write(Buffer.from([0xe2])); process.stdout.write(Buffer.from([0x82, 0xac, 0x0a])); void 0",
    );
    expect(exec.status).toBe("ok");
    expect(texts(exec, "stdout")).toEqual(["€\n"]);
  });
});

test("Bun captured writes preserve callbacks and input validation", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("captured-write-contract");

    const callbackExec = await actor.run(
      sessionId,
      [
        "let callbackOutcome = 'not-called';",
        "try { await new Promise((resolve) => process.stdout.write('callback\\n', resolve)); callbackOutcome = 'ok'; } catch (error) { callbackOutcome = String(error); }",
        "callbackOutcome",
      ].join("\n"),
    );
    expect(callbackExec.status).toBe("ok");
    expect(texts(callbackExec, "stdout")).toEqual(["callback\n"]);
    expect(texts(callbackExec, "result")).toEqual(['"ok"']);

    const invalidExec = await actor.run(
      sessionId,
      "process.stdout.write(null); 40 + 2",
    );
    expect(invalidExec.status).toBe("error");
    expect(texts(invalidExec, "error")).toEqual([
      expect.stringContaining(
        "process stream writes require a string or ArrayBuffer view",
      ),
    ]);
    expect(
      invalidExec.messages.some((message) => message.kind === "result"),
    ).toBe(false);
  });
});
