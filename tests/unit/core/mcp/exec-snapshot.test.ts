import { expect, test } from "bun:test";
import {
  renderExecSnapshotText,
  renderExecText,
  renderExecTextContent,
  projectExecText,
  MAX_SNAPSHOT_OUTPUT_TOKENS,
  validateExecFromSeq,
  validateSnapshotTokenLimit,
  approxTokenCount,
  formattedTruncateText,
  truncateTextToByteBudget,
  TRUNCATION_MARKER_MAX_BYTES,
  type ExecMessageRecord,
} from "@bayma/core";

test("snapshots render semantic messages into visible text", () => {
  const messages: ExecMessageRecord[] = [
    {
      seq: 1,
      messageId: "exec_1",
      kind: "stdout",
      text: "alpha\nbeta",
      occurredAtMs: 1,
    },
    {
      seq: 2,
      messageId: "exec_2",
      kind: "result",
      text: "42",
      occurredAtMs: 2,
    },
    {
      seq: 3,
      messageId: "exec_3",
      kind: "result",
      text: "43",
      occurredAtMs: 3,
    },
    {
      seq: 4,
      messageId: "exec_4",
      kind: "error",
      text: "boom\nstack",
      occurredAtMs: 4,
    },
    {
      seq: 5,
      messageId: "exec_5",
      kind: "error",
      text: "second error",
      occurredAtMs: 5,
    },
  ];

  const rendered = renderExecText(messages);
  expect(rendered).toEqual({
    stdoutText: "alpha\nbeta",
    stderrText: "",
    resultText: "42\n43",
    errorText: "boom\nstack\nsecond error",
  });
  expect(renderExecTextContent(rendered)).toBe(
    "alpha\nbeta\n42\n43\nboom\nstack\nsecond error",
  );
});

test("token truncation preserves head and tail around a bounded marker", () => {
  expect(formattedTruncateText("one\ntwo\nthree", 2)).toEqual({
    text: "Total output lines: 3\n\none\n…2 tokens truncated…hree",
    truncated: true,
    originalTokenCount: approxTokenCount("one\ntwo\nthree"),
  });
});

test("snapshot text is derived from the already-bounded structured fields", () => {
  expect(
    renderExecSnapshotText({
      stdout_text: "one\ntwo\nthree\n",
      stderr_text: "",
      result_text: "42",
      error_text: "",
    }),
  ).toBe("one\ntwo\nthree\n42");
});

test("one snapshot budget is projected across the structured channels", () => {
  const projected = projectExecText(
    {
      stdoutText: "alpha\nbeta\ngamma",
      stderrText: "warning-warning",
      resultText: "result-result",
      errorText: "",
    },
    4,
  );

  expect(projected.truncated).toBe(true);
  expect(projected.originalTokenCount).toBe(
    approxTokenCount("alpha\nbeta\ngamma\nwarning-warning\nresult-result"),
  );
  expect(projected.rendered.stdoutText).toContain("tokens truncated");
  expect(projected.rendered.stderrText).toContain("tokens truncated");
  expect(projected.rendered.resultText).toContain("tokens truncated");
  expect(projected.rendered.errorText).toBe("");
  expect(
    Buffer.byteLength(projected.rendered.stdoutText, "utf8") +
      Buffer.byteLength(projected.rendered.stderrText, "utf8") +
      Buffer.byteLength(projected.rendered.resultText, "utf8"),
  ).toBeLessThanOrEqual(16 + 3 * TRUNCATION_MARKER_MAX_BYTES);
});

test("snapshot projection preserves unicode boundaries", () => {
  const projected = projectExecText(
    {
      stdoutText: "😀αβγδεζηθικλμνξοπρστυφχψω😀",
      stderrText: "",
      resultText: "",
      errorText: "",
    },
    3,
  );

  expect(projected.truncated).toBe(true);
  expect(projected.rendered.stdoutText).not.toContain("�");
  expect(projected.rendered.stdoutText).toContain("tokens truncated");
  expect(truncateTextToByteBudget("😀😀😀", 5).text).toBe(
    "…3 tokens truncated…",
  );
});

test("snapshot budgets reject non-finite and operationally meaningless limits", () => {
  expect(() => validateSnapshotTokenLimit(Number.NaN)).toThrow(
    "snapshot token limit must be an integer",
  );
  expect(() =>
    validateSnapshotTokenLimit(MAX_SNAPSHOT_OUTPUT_TOKENS + 1),
  ).toThrow("snapshot token limit must be an integer");
});

test("incremental snapshot cursors reject lossy or non-finite values", () => {
  for (const value of [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => validateExecFromSeq(value)).toThrow(
      "exec snapshot fromSeq must be a positive safe integer",
    );
  }
  expect(validateExecFromSeq(Number.MAX_SAFE_INTEGER)).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});
