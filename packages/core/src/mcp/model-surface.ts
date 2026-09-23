import type { RuntimeRegistry } from "../runtime/registry.ts";
import { SESSIONS_URI } from "./uris.ts";

/** The server's name and the instructions the model reads before using it. */
export interface ModelSurface {
  serverName: "bayma";
  instructions: string;
}

function readableList(values: readonly string[]): string {
  if (values.length === 1) return values[0]!;
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function createModelSurface(
  registry: RuntimeRegistry,
  snapshotTokenLimit: number,
): ModelSurface {
  const profiles = registry.list().map(({ adapter }) => adapter.modelProfile);
  return {
    serverName: "bayma",
    instructions: [
      `Bayma executes code in long-lived ${readableList(profiles.map(({ heading }) => heading))} sessions.`,
      "Create a session with session.create, selecting exactly one runtime. The selected runtime is fixed for the lifetime of the session.",
      "Sessions preserve live language state across exec calls while their runtime remains up. Bayma manages persistence and restart recovery internally.",
      "Use exec to evaluate source code in the session's selected runtime. The code argument contains raw source text; do not include Markdown code fences.",
      "Use yield_time_ms on exec to wait for an inline first snapshot. It defaults to 10000 ms.",
      `Use max_output_tokens to control the approximate content-token budget. It defaults to ${snapshotTokenLimit} tokens.`,
      "If exec returns done: false, use wait with the returned session_id, exec_id, and next_seq.",
      "Wait returns only output at or after from_seq, or the terminal result when execution finishes.",
      "Both tools return bounded terminal-like text plus structured stdout, stderr, result, and error channels.",
      "Use session lifecycle tools only when control, interruption, terminal sizing, reconnection, or permanent closure is required.",
      `Read ${SESSIONS_URI} to discover sessions and exec resources to inspect complete retained execution history.`,
      ...profiles.map(
        ({ heading, description }) => `${heading}: ${description}`,
      ),
    ].join(" "),
  };
}
