import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { SAFE_PERSISTED_ID_PATTERN } from "../ids.ts";
import { RUNTIME_IDS } from "../runtime/id.ts";
import { EXEC_STATUSES } from "../session/exec-types.ts";
import { SESSION_STATUSES, type SessionSummary } from "../session/model.ts";
import type { SessionManager } from "../session/session-manager.ts";
import {
  collectExecSnapshot,
  MAX_EXEC_YIELD_TIME_MS,
  MAX_SNAPSHOT_OUTPUT_TOKENS,
  renderExecSnapshotText,
  type ExecSnapshot,
} from "./exec-snapshot.ts";

// The tool surface. Every tool declares its input and output schema; results
// are snake_case projections of the session model.

const RuntimeIdSchema = z.enum(RUNTIME_IDS);
const IdSchema = z.string().regex(SAFE_PERSISTED_ID_PATTERN);
const SessionIdSchema = IdSchema.describe("Identifier of the Bayma session.");

const SessionSummarySchema = z.strictObject({
  session_id: IdSchema,
  runtime: RuntimeIdSchema.optional(),
  title: z.string(),
  cwd: z.string().min(1),
  status: z.enum(SESSION_STATUSES),
  quarantine_reason: z.string().optional(),
  created_at_ms: z.number().finite().nonnegative(),
  updated_at_ms: z.number().finite().nonnegative(),
  controller_actor_id: z.string().optional(),
  observer_actor_ids: z.array(z.string()),
  history_length: z.number().int().nonnegative(),
});
const SessionResultSchema = z.strictObject({ session: SessionSummarySchema });
const CreatedSessionResultSchema = z.strictObject({
  session: SessionSummarySchema.extend({ runtime: RuntimeIdSchema }),
});
const ExecSnapshotSchema = z.strictObject({
  session_id: IdSchema,
  exec_id: IdSchema,
  runtime: RuntimeIdSchema,
  status: z.enum(EXEC_STATUSES),
  done: z.boolean(),
  wall_time_seconds: z.number().finite().nonnegative(),
  from_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  next_seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  changed: z.boolean(),
  truncated: z.boolean(),
  original_token_count: z.number().int().positive().optional(),
  stdout_text: z.string(),
  stderr_text: z.string(),
  result_text: z.string(),
  error_text: z.string(),
});

const YieldTimeSchema = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_EXEC_YIELD_TIME_MS)
  .optional();
const MaxOutputTokensSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_SNAPSHOT_OUTPUT_TOKENS)
  .optional();

const MUTATING = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const READ_ONLY = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

interface ToolContext {
  sessionId?: string;
}

function projectSession(session: SessionSummary) {
  return {
    session_id: session.sessionId,
    runtime: session.runtimeId,
    title: session.title,
    cwd: session.cwd,
    status: session.status,
    quarantine_reason: session.quarantineReason,
    created_at_ms: session.createdAtMs,
    updated_at_ms: session.updatedAtMs,
    controller_actor_id: session.controllerActorId,
    observer_actor_ids: session.observerActorIds,
    history_length: session.historyLength,
  };
}

function sessionResult(session: SessionSummary) {
  const value = { session: projectSession(session) };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function execSnapshotResult(snapshot: ExecSnapshot) {
  return {
    content: [
      { type: "text" as const, text: renderExecSnapshotText(snapshot) },
    ],
    structuredContent: { ...snapshot },
  };
}

export function registerMcpTools(
  server: McpServer,
  manager: SessionManager,
  resolveActorId: (context: ToolContext) => string,
  snapshotTokenLimit: number,
): void {
  // Only runtimes this server hosts can be selected; a restored session may
  // still name another, which the projections above admit.
  const [first, ...rest] = manager.runtimeIds();
  const HostedRuntimeSchema = z.enum([first!, ...rest]);

  server.registerTool(
    "session.create",
    {
      title: "Create Session",
      description:
        "Start a long-lived Bayma session in exactly one language runtime. The selected runtime is fixed for the lifetime of the session.",
      inputSchema: z.strictObject({
        runtime: HostedRuntimeSchema.describe(
          "Language runtime for the new session. The selected runtime is fixed for the lifetime of the session.",
        ),
        title: z
          .string()
          .describe(
            "Human-readable label for the session. This appears in resource names and client UIs.",
          ),
        cwd: z
          .string()
          .min(1)
          .describe(
            "Working directory for the session. Relative paths, imports, packages, modules, script references, and local dependencies resolve from this directory according to the selected runtime.",
          ),
        role: z
          .enum(["controller", "observer"])
          .optional()
          .describe(
            "Use controller to execute code and mutate session state. Use observer for read-only access.",
          ),
      }),
      outputSchema: CreatedSessionResultSchema,
      annotations: MUTATING,
    },
    async ({ runtime, title, cwd, role }, context) =>
      sessionResult(
        await manager.create(
          resolveActorId(context),
          title,
          cwd,
          role ?? "controller",
          runtime,
        ),
      ),
  );

  server.registerTool(
    "session.acquire_controller",
    {
      title: "Acquire Session Control",
      description:
        "Take exclusive control of a known session so this client can execute code, interrupt, resize, recover, or close it.",
      inputSchema: z.strictObject({ session_id: SessionIdSchema }),
      outputSchema: SessionResultSchema,
      annotations: READ_ONLY,
    },
    async ({ session_id }, context) =>
      sessionResult(
        await manager.attach(session_id, resolveActorId(context), "controller"),
      ),
  );

  server.registerTool(
    "session.release_controller",
    {
      title: "Release Session Control",
      description:
        "Release exclusive control while keeping the session available for reconnect or observation.",
      inputSchema: z.strictObject({ session_id: SessionIdSchema }),
      outputSchema: SessionResultSchema,
      annotations: READ_ONLY,
    },
    async ({ session_id }, context) =>
      sessionResult(await manager.detach(session_id, resolveActorId(context))),
  );

  server.registerTool(
    "exec",
    {
      title: "Execute In Session",
      description: [
        "Run code in a persistent Bayma session.",
        "- Evaluates the provided source in the session's selected language runtime.",
        "- State from previous exec calls in the same live session remains available.",
        "- The code field contains raw source text. Do not include Markdown code fences.",
        "- yield_time_ms asks exec to wait for an inline first snapshot. Defaults to 10000 ms.",
        `- max_output_tokens sets the approximate content-token budget for returned output. Defaults to ${snapshotTokenLimit} tokens.`,
        "- If the result has done: false, use wait with its session_id, exec_id, and next_seq.",
      ].join("\n"),
      inputSchema: z.strictObject({
        session_id: SessionIdSchema.describe(
          "Identifier of the Bayma session in which to execute the code.",
        ),
        code: z
          .string()
          .describe(
            "Source code to execute in the session's selected language runtime. Provide raw source text without Markdown code fences.",
          ),
        yield_time_ms: YieldTimeSchema.describe(
          "How long to wait for inline output before yielding. Defaults to 10000 ms.",
        ),
        max_output_tokens: MaxOutputTokensSchema.describe(
          `Output token budget for this exec call. Defaults to ${snapshotTokenLimit} tokens.`,
        ),
      }),
      outputSchema: ExecSnapshotSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ session_id, code, yield_time_ms, max_output_tokens }, context) => {
      const { execId } = await manager.submitExec(
        session_id,
        resolveActorId(context),
        code,
      );
      return execSnapshotResult(
        await collectExecSnapshot(manager, session_id, execId, {
          fromSeq: 1,
          yieldTimeMs: yield_time_ms,
          maxOutputTokens: max_output_tokens ?? snapshotTokenLimit,
          defaultMaxOutputTokens: snapshotTokenLimit,
        }),
      );
    },
  );

  server.registerTool(
    "wait",
    {
      title: "Wait For Execution",
      description: [
        "Waits on a yielded exec and returns new output or completion.",
        "- Use wait only after exec returns done: false.",
        "- session_id and exec_id identify the running execution to resume.",
        "- from_seq selects the first output sequence to return. Use next_seq from the preceding snapshot.",
        "- yield_time_ms controls how long to wait for more output before yielding again. Defaults to 10000 ms.",
        `- max_output_tokens limits how much output this wait call returns. Defaults to ${snapshotTokenLimit} tokens.`,
        "- wait returns only output at or after from_seq, or the terminal result when execution finishes.",
        "- If execution is still running, wait may yield again with the same session_id and exec_id.",
      ].join("\n"),
      inputSchema: z.strictObject({
        session_id: SessionIdSchema.describe(
          "Identifier of the session that owns the running exec.",
        ),
        exec_id: IdSchema.describe("Identifier of the running exec to resume."),
        from_seq: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "First output sequence number to return. Use next_seq from the preceding exec or wait result.",
          ),
        yield_time_ms: YieldTimeSchema.describe(
          "How long to wait for more output before yielding again. Defaults to 10000 ms.",
        ),
        max_output_tokens: MaxOutputTokensSchema.describe(
          `Output token budget for this wait call. Defaults to ${snapshotTokenLimit} tokens.`,
        ),
      }),
      outputSchema: ExecSnapshotSchema,
      annotations: READ_ONLY,
    },
    async ({
      session_id,
      exec_id,
      from_seq,
      yield_time_ms,
      max_output_tokens,
    }) =>
      execSnapshotResult(
        await collectExecSnapshot(manager, session_id, exec_id, {
          fromSeq: from_seq,
          yieldTimeMs: yield_time_ms,
          maxOutputTokens: max_output_tokens ?? snapshotTokenLimit,
          defaultMaxOutputTokens: snapshotTokenLimit,
        }),
      ),
  );

  server.registerTool(
    "session.interrupt",
    {
      title: "Interrupt Execution",
      description:
        "Try a soft interrupt first. Bayma may recycle the selected language runtime if needed to recover a stuck session.",
      inputSchema: z.strictObject({ session_id: SessionIdSchema }),
      outputSchema: SessionResultSchema,
      annotations: MUTATING,
    },
    async ({ session_id }, context) =>
      sessionResult(
        await manager.interrupt(session_id, resolveActorId(context)),
      ),
  );

  server.registerTool(
    "session.resize",
    {
      title: "Resize Session Terminal",
      description:
        "Update the terminal size for a session when output depends on PTY dimensions.",
      inputSchema: z.strictObject({
        session_id: SessionIdSchema,
        cols: z
          .number()
          .int()
          .positive()
          .max(65_535)
          .describe("Terminal width in columns."),
        rows: z
          .number()
          .int()
          .positive()
          .max(65_535)
          .describe("Terminal height in rows."),
      }),
      outputSchema: SessionResultSchema,
      annotations: READ_ONLY,
    },
    async ({ session_id, cols, rows }, context) =>
      sessionResult(
        await manager.resize(session_id, resolveActorId(context), cols, rows),
      ),
  );

  server.registerTool(
    "session.close",
    {
      title: "Close Session",
      description:
        "Permanently close the session and discard its live language state, persisted checkpoint, runtime scratch state, and execution history.",
      inputSchema: z.strictObject({ session_id: SessionIdSchema }),
      outputSchema: SessionResultSchema,
      annotations: MUTATING,
    },
    async ({ session_id }, context) =>
      sessionResult(await manager.close(session_id, resolveActorId(context))),
  );
}
