import { expect, test } from "bun:test";
import {
  buildMarkers,
  createPromptAwareEnvelopeCollector,
  parseExecWindow,
  ProcessTransport,
  boundRuntimeText,
  RUNTIME_OUTPUT_CAPTURE_POLICY,
} from "@bayma/core";

test("the marker parser reports finish only after the prompt follows done", () => {
  const markers = buildMarkers();
  const incomplete = parseExecWindow(
    [
      `${markers.eventPrefix}{"kind":"stdout","text":"42\\n"}`,
      `${markers.eventPrefix}{"kind":"done"}`,
    ],
    markers,
    [">", "❯", "..."],
  );
  expect(incomplete.done).toBe(false);
  expect(incomplete.envelopes).toEqual([{ kind: "stdout", text: "42\n" }]);

  const complete = parseExecWindow(
    [
      `${markers.eventPrefix}{"kind":"stdout","text":"42\\n"}`,
      `${markers.eventPrefix}{"kind":"checkpoint-preserved"}`,
      `${markers.eventPrefix}{"kind":"done"}`,
      "> ",
    ],
    markers,
    [">", "❯", "..."],
  );
  expect(complete.done).toBe(true);
  expect(complete.envelopes).toEqual([
    { kind: "stdout", text: "42\n" },
    { kind: "checkpoint-preserved" },
  ]);

  const malformed = parseExecWindow(
    [
      `${markers.eventPrefix}{"kind":"invented","text":"poison"}`,
      `${markers.eventPrefix}{"kind":"stdout","text":{"not":"text"}}`,
      `${markers.eventPrefix}{"kind":"stdout"}`,
      `${markers.eventPrefix}{"kind":"done","text":"not done"}`,
      `${markers.eventPrefix}{"kind":"checkpoint"}`,
      `${markers.eventPrefix}{"kind":"checkpoint","checkpoint":{"runtimeId":"bun","codecId":"codec","codecVersion":1,"payloadKind":"json-inline"}}`,
      `${markers.eventPrefix}{"kind":"checkpoint","checkpoint":{"runtimeId":"bun","codecId":"codec","codecVersion":1,"payloadKind":"binary-sidecar","payloadPath":"payload.bin","inlineJson":null}}`,
      `${markers.eventPrefix}{"kind":"checkpoint","checkpoint":{"runtimeId":"bun","codecId":"codec","codecVersion":1,"payloadKind":"binary-sidecar","payloadPath":"payload.bin","sha256":"not-a-digest"}}`,
      `${markers.eventPrefix}{"kind":"checkpoint-preserved","text":"ambiguous"}`,
      `${markers.eventPrefix}{"kind":"result","text":"42","extra":true}`,
      `${markers.eventPrefix}{"kind":"done"}`,
      "> ",
    ],
    markers,
    [">"],
  );
  expect(malformed.done).toBe(true);
  expect(malformed.envelopes).toEqual([]);
});

test("live collector processes noisy chunked output once", () => {
  const markers = buildMarkers();
  const collector = createPromptAwareEnvelopeCollector(markers, [">"]);
  const noise = Array.from(
    { length: 10_000 },
    (_, index) => `unrelated terminal line ${index}\n`,
  ).join("");

  expect(collector.push(noise)).toEqual({ done: false, envelopes: [] });
  expect(
    collector.push(
      `${markers.eventPrefix}{"kind":"stdout","text":"once\\n"}\n` +
        `${markers.eventPrefix}{"kind":"do`,
    ),
  ).toEqual({
    done: false,
    envelopes: [{ kind: "stdout", text: "once\n" }],
  });
  expect(collector.push(`ne"}\n`)).toEqual({
    done: false,
    envelopes: [],
  });
  expect(collector.push("> ")).toEqual({ done: true, envelopes: [] });
  expect(collector.push("\n")).toEqual({ done: true, envelopes: [] });
});

test("live collector discards unbounded raw line prefixes without losing later envelopes", () => {
  const markers = buildMarkers();
  const collector = createPromptAwareEnvelopeCollector(markers, [">"]);
  for (let index = 0; index < 16; index += 1) {
    expect(collector.push("x".repeat(128 * 1024)).envelopes).toEqual([]);
  }
  const observed = collector.push(
    `${markers.eventPrefix}${JSON.stringify({ kind: "result", text: "42" })}\n` +
      `${markers.eventPrefix}${JSON.stringify({ kind: "done" })}\n> `,
  );
  expect(observed).toEqual({
    done: true,
    envelopes: [{ kind: "result", text: "42" }],
  });
});

test("execution markers carry fresh cryptographic entropy", () => {
  const first = buildMarkers().eventPrefix;
  const second = buildMarkers().eventPrefix;
  expect(first).toMatch(/^__BAYMA_EVENT_[0-9a-f]{32}__$/);
  expect(second).toMatch(/^__BAYMA_EVENT_[0-9a-f]{32}__$/);
  expect(second).not.toBe(first);
});

test("runtime text bounds preserve UTF-8 and the exact byte ceiling", () => {
  const bounded = boundRuntimeText("😀".repeat(40_000));
  expect(bounded.truncated).toBe(true);
  expect(bounded.text).toContain("Bayma truncated runtime message");
  expect(bounded.text).not.toContain("�");
  expect(Buffer.byteLength(bounded.text, "utf8")).toBeLessThanOrEqual(
    RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessageBytes,
  );
});

test(
  "process transport detects prompts split across output and ANSI chunks",
  async () => {
    const transport = new ProcessTransport({
      platformId: "test",
      promptRe: /(?:^|[\r\n])❯ /g,
      promptTimeoutMs: 1_000,
      command: () => ({
        file: process.execPath,
        args: [
          "-e",
          `const output = Buffer.from("\\n\\x1b[32m❯ \\x1b[0m"); const split = output.indexOf(Buffer.from("❯")) + 1; process.stdout.write(output.subarray(0, split)); setTimeout(() => process.stdout.write(output.subarray(split)), 25); setInterval(() => undefined, 1_000);`,
        ],
      }),
    });
    const handle = await transport.startSession({
      sessionId: "sess_split_prompt",
      title: "split prompt",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    try {
      await transport.waitForInitialPrompt(handle);
      expect(transport.promptCount(handle)).toBe(1);
    } finally {
      await transport.terminate(handle);
      await transport.shutdown();
    }
  },
  { timeout: 3_000 },
);

test(
  "process transport never treats stderr as prompt authority",
  async () => {
    const transport = new ProcessTransport({
      platformId: "test",
      promptRe: /(?:^|[\r\n])BAYMA> /g,
      promptTimeoutMs: 100,
      command: () => ({
        file: process.execPath,
        args: [
          "-e",
          `process.stderr.write("\\nBAYMA> "); setInterval(() => undefined, 1_000);`,
        ],
      }),
    });
    const handle = await transport.startSession({
      sessionId: "sess_stderr_prompt",
      title: "stderr prompt",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    try {
      await expect(transport.waitForInitialPrompt(handle)).rejects.toThrow(
        "timed out waiting for prompt",
      );
      expect(transport.promptCount(handle)).toBe(0);
    } finally {
      await transport.terminate(handle);
      await transport.shutdown();
    }
  },
  { timeout: 3_000 },
);

test(
  "process transport does not impose an undocumented global-regexp precondition",
  async () => {
    const transport = new ProcessTransport({
      platformId: "test",
      promptRe: /(?:^|[\r\n])BAYMA> /,
      promptTimeoutMs: 1_000,
      command: () => ({
        file: process.execPath,
        args: [
          "-e",
          `process.stdout.write("\\nBAYMA> "); setInterval(() => undefined, 1_000);`,
        ],
      }),
    });
    const handle = await transport.startSession({
      sessionId: "sess_non_global_prompt",
      title: "non-global prompt matcher",
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    try {
      await transport.waitForInitialPrompt(handle);
      expect(transport.promptCount(handle)).toBe(1);
    } finally {
      await transport.terminate(handle);
      await transport.shutdown();
    }
  },
  { timeout: 3_000 },
);

test("process transport reports spawn errors instead of crashing", async () => {
  const transport = new ProcessTransport({
    platformId: "test",
    promptRe: /(?:^|[\r\n])BAYMA> /g,
    promptTimeoutMs: 1_000,
    command: () => ({
      file: `bayma-command-that-does-not-exist-${process.pid}`,
      args: [],
    }),
  });
  const handle = await transport.startSession({
    sessionId: "sess_spawn_failure",
    title: "spawn failure",
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });

  await expect(transport.waitForInitialPrompt(handle)).rejects.toThrow(
    "failed to start",
  );
  await transport.shutdown();
});
