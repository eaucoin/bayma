import { expect, test } from "bun:test";
import { TRUNCATION_MARKER_MAX_BYTES } from "@bayma/core";
import { BUN_INSPECTION_POLICY } from "@bayma/runtime-bun";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";

test("inline snapshots support waiting and truncation", async () => {
  await withMcpStdio(async (client) => {
    const created = await client.callTool<{ session: { session_id: string } }>(
      "session.create",
      {
        runtime: "bun",
        title: "mcp-inline-snapshots",
        cwd: process.cwd(),
      },
    );
    const sessionId = created.session.session_id;
    const submitAndSettle = async (
      code: string,
      maxOutputTokens?: number,
    ): Promise<ExecSnapshot> => {
      const first = await client.callTool<ExecSnapshot>("exec", {
        session_id: sessionId,
        code,
        yield_time_ms: 1_000,
        ...(maxOutputTokens === undefined
          ? {}
          : { max_output_tokens: maxOutputTokens }),
      });
      return await waitForSettledExec(client, sessionId, first, {
        maxOutputTokens,
      });
    };

    const defaultYield = await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code: "await new Promise((resolve) => setTimeout(resolve, 50)); 21 * 2",
    });
    expect(defaultYield.done).toBe(true);
    expect(defaultYield.status).toBe("ok");
    expect(defaultYield.runtime).toBe("bun");
    expect(defaultYield.result_text).toBe("42");

    const submittedResult = await client.callToolResult("exec", {
      session_id: sessionId,
      code: `
for (const line of ["one", "two", "three"]) console.log(line);
await new Promise((resolve) => setTimeout(resolve, 500));
for (const line of ["four", "five", "six"]) console.log(line);
42
      `.trim(),
      yield_time_ms: 150,
      max_output_tokens: 2,
    });
    expect(submittedResult.isError).toBe(false);

    const submitted = submittedResult.structuredContent as {
      session_id: string;
      exec_id: string;
      status: string;
      done: boolean;
      from_seq: number;
      next_seq: number;
      changed: boolean;
      truncated: boolean;
      original_token_count?: number;
      stdout_text: string;
      result_text: string;
    };

    expect(submitted.session_id).toBe(sessionId);
    expect(submitted.done).toBe(false);
    expect(
      submitted.status === "queued" || submitted.status === "running",
    ).toBe(true);
    expect(submitted.from_seq).toBe(1);
    expect(submitted.next_seq).toBeGreaterThan(1);
    expect(submitted.changed).toBe(true);
    expect(submitted.truncated).toBe(true);
    expect(submitted.original_token_count).toBe(4);
    expect(submitted.stdout_text).toContain("one");
    expect(submitted.stdout_text).toContain("tokens truncated");
    expect(submitted.stdout_text).toContain("ree");
    expect(submitted.result_text).toBe("");
    expect(submittedResult.content).toEqual([
      {
        type: "text",
        text: submitted.stdout_text.trimEnd(),
      },
    ]);
    expect(
      Buffer.byteLength(submitted.stdout_text, "utf8"),
    ).toBeLessThanOrEqual(2 * 4 + TRUNCATION_MARKER_MAX_BYTES);

    const waitedResult = await client.callToolResult("wait", {
      session_id: sessionId,
      exec_id: submitted.exec_id,
      from_seq: submitted.next_seq,
      yield_time_ms: 1_000,
      max_output_tokens: 3,
    });
    expect(waitedResult.isError).toBe(false);

    const waited = waitedResult.structuredContent as {
      done: boolean;
      status: string;
      from_seq: number;
      next_seq: number;
      changed: boolean;
      truncated: boolean;
      original_token_count?: number;
      stdout_text: string;
      result_text: string;
    };

    expect(waited.done).toBe(true);
    expect(waited.status).toBe("ok");
    expect(waited.from_seq).toBe(submitted.next_seq);
    expect(waited.next_seq).toBeGreaterThan(waited.from_seq);
    expect(waited.changed).toBe(true);
    expect(waited.truncated).toBe(true);
    expect(waited.original_token_count).toBe(4);
    expect(waited.stdout_text).not.toContain("one");
    expect(waited.stdout_text).toContain("four");
    expect(waited.stdout_text).toContain("six");
    expect(waited.result_text).toBe("42");
    expect(waitedResult.content).toEqual([
      {
        type: "text",
        text: `${waited.stdout_text.trimEnd()}\n${waited.result_text}`,
      },
    ]);
    expect(
      Buffer.byteLength(waited.stdout_text, "utf8") +
        Buffer.byteLength(waited.result_text, "utf8"),
    ).toBeLessThanOrEqual(3 * 4 + 2 * TRUNCATION_MARKER_MAX_BYTES);

    const emptyWait = await client.callTool<{
      changed: boolean;
      stdout_text: string;
      result_text: string;
    }>("wait", {
      session_id: sessionId,
      exec_id: submitted.exec_id,
      from_seq: waited.next_seq,
      yield_time_ms: 10,
      max_output_tokens: 3,
    });
    expect(emptyWait.changed).toBe(false);
    expect(emptyWait.stdout_text).toBe("");
    expect(emptyWait.result_text).toBe("");

    const largeResult = await submitAndSettle('"x".repeat(200_000)', 1_000);
    expect(largeResult.done).toBe(true);
    expect(largeResult.truncated).toBe(true);
    expect(
      Buffer.byteLength(largeResult.result_text ?? "", "utf8"),
    ).toBeLessThanOrEqual(1_000 * 4 + TRUNCATION_MARKER_MAX_BYTES);

    const resource = await client.readJsonResource<{
      exec: { messages: Array<{ kind: string; text: string }> };
    }>(`bayma:///session/${sessionId}/exec/${largeResult.exec_id}`);
    const durableResult = resource.exec.messages.find(
      (message) => message.kind === "result",
    );
    expect(durableResult).toBeDefined();
    expect(Buffer.byteLength(durableResult!.text, "utf8")).toBeLessThanOrEqual(
      BUN_INSPECTION_POLICY.maxRenderedBytes,
    );
    expect(durableResult!.text).toContain("characters omitted");

    const retainedOriginal = await submitAndSettle("_.length");
    expect(retainedOriginal.result_text).toBe("200000");

    const pathological = await submitAndSettle(
      `
const value = {
  items: Array.from({ length: 100_000 }, (_, index) => index),
  map: new Map(Array.from({ length: 10_000 }, (_, index) => [index, { index }])),
};
Object.defineProperty(value, "dangerous", { enumerable: true, get() { throw new Error("getter executed"); } });
value.self = value;
value
      `.trim(),
      1_000,
    );
    expect(pathological.done).toBe(true);
    expect(pathological.result_text).toMatch(/more items|entries omitted/);
    expect(pathological.result_text).toContain("[Circular]");
    expect(pathological.result_text).toContain("[Getter/Setter]");
    expect(pathological.result_text).not.toContain("getter executed");
    expect(
      Buffer.byteLength(pathological.result_text ?? "", "utf8"),
    ).toBeLessThanOrEqual(1_000 * 4 + 4 * TRUNCATION_MARKER_MAX_BYTES);

    const hostileProxy = await submitAndSettle(
      `
const hostile = new Proxy({}, {
  getPrototypeOf() { throw new Error("prototype trap executed"); },
});
hostile
      `.trim(),
    );
    expect(hostileProxy.status).toBe("ok");
    expect(hostileProxy.result_text).toBe("[Bayma could not inspect value]");
    expect(hostileProxy.error_text).toBe("");

    const retainedHostileProxy = await submitAndSettle("_ === hostile");
    expect(retainedHostileProxy.status).toBe("ok");
    expect(retainedHostileProxy.result_text).toBe("true");

    const largeConsole = await submitAndSettle(
      "console.log(Array.from({ length: 100_000 }, (_, index) => index)); undefined",
      1_000,
    );
    expect(largeConsole.done).toBe(true);
    expect(largeConsole.stdout_text).toMatch(/more items|entries omitted/);
    const consoleResource = await client.readJsonResource<{
      exec: { messages: Array<{ kind: string; text: string }> };
    }>(`bayma:///session/${sessionId}/exec/${largeConsole.exec_id}`);
    const durableStdout = consoleResource.exec.messages.find(
      (message) => message.kind === "stdout",
    );
    expect(durableStdout).toBeDefined();
    expect(Buffer.byteLength(durableStdout!.text, "utf8")).toBeLessThanOrEqual(
      BUN_INSPECTION_POLICY.maxRenderedBytes,
    );

    await client.callTool("session.close", { session_id: sessionId });
  });
}, 30_000);
