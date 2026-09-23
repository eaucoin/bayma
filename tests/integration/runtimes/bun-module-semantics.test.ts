import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine-harness.ts";

test("import and require behave as in the Bun REPL", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("imports");
    const exec = await actor.run(
      sessionId,
      [
        'const path = await import("node:path")',
        'console.log(require("node:path").basename("/a/b"))',
        'console.log(path.basename("/a/b"))',
        "console.log(__filename)",
        "console.log(JSON.stringify(__dirname))",
      ].join("\n"),
    );
    const transcript = exec.messages.map((message) => message.text).join("");
    expect(transcript).toContain("b");
    // Cells are transpiled as TypeScript, which names the module input.ts.
    expect(transcript).toContain("input.ts");
    expect(transcript).toContain('""');
  });
});

test("TypeScript syntax evaluates as in the Bun REPL, and JavaScript is unchanged", async () => {
  await withEngine(async ({ actor }) => {
    const { sessionId } = await actor.create("typescript");
    const typed = await actor.run(
      sessionId,
      [
        "interface Point { x: number; y: number }",
        "type Pair<T> = [T, T]",
        "const identity = <T,>(value: T): T => value",
        "function norm(point: Point): number { return Math.hypot(point.x, point.y) }",
        "let pair: Pair<number> = [3, 4]",
        "const point = { x: pair[0], y: pair[1] } as Point",
        "console.log(identity<string>('typed'))",
        "norm(point)",
      ].join("\n"),
    );
    const typedTranscript = typed.messages
      .map((message) => message.text)
      .join("");
    expect(typed.status).toBe("ok");
    expect(typedTranscript).toContain("typed");
    expect(typedTranscript).toContain("5");

    const plain = await actor.run(
      sessionId,
      "const doubled = [1, 2].map((n) => n * 2)\ndoubled.join(',')",
    );
    expect(plain.status).toBe("ok");
    expect(plain.messages.map((message) => message.text).join("")).toContain(
      "2,4",
    );
  });
});
