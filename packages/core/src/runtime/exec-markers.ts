import { randomBytes } from "node:crypto";
import {
  parseRuntimeExecEnvelope,
  type RuntimeExecEnvelope,
  type RuntimeOutputCollector,
} from "./adapter.ts";
import { RUNTIME_OUTPUT_CAPTURE_POLICY } from "./output-capture.ts";

export interface ExecMarkers {
  eventPrefix: string;
}

export interface ParsedExecWindow {
  done: boolean;
  envelopes: RuntimeExecEnvelope[];
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// JSON may expand one input byte into a six-character `\uXXXX` escape. Keep
// enough tail for one maximally expanded bounded envelope plus framing while
// discarding raw, unterminated terminal output that has no protocol meaning.
const MAX_PROJECTOR_REMAINDER_CHARACTERS =
  RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessageBytes * 6 + 4_096;

export function buildMarkers(): ExecMarkers {
  const nonce = randomBytes(16).toString("hex");
  return {
    eventPrefix: `__BAYMA_EVENT_${nonce}__`,
  };
}

export function sanitizeTerminalText(chunk: string): string {
  return chunk.replace(ANSI_RE, "").replace(/\r/g, "\n");
}

export class Utf8LineProjector {
  private remainder = "";

  push(text: string): string[] {
    this.remainder += sanitizeTerminalText(text);
    const lines = this.remainder.split("\n");
    this.remainder = lines.pop() ?? "";
    if (this.remainder.length > MAX_PROJECTOR_REMAINDER_CHARACTERS) {
      this.remainder = this.remainder.slice(
        -MAX_PROJECTOR_REMAINDER_CHARACTERS,
      );
    }
    return lines.map((line) => line.trimEnd()).filter(Boolean);
  }

  previewLines(): string[] {
    const tail = this.remainder.trimEnd();
    return tail ? [tail] : [];
  }

  finish(): string[] {
    const tail = this.remainder.trimEnd();
    this.remainder = "";
    return tail ? [tail] : [];
  }
}

export function parseExecWindow(
  lines: string[],
  markers: ExecMarkers,
  promptLines: ReadonlySet<string> | readonly string[],
): ParsedExecWindow {
  const resolvedPromptLines = new Set(
    Array.from(promptLines, (token) => token.trim()),
  );
  const envelopes: RuntimeExecEnvelope[] = [];
  let doneIndex = -1;

  lines.forEach((line, index) => {
    const envelope = parseEnvelopeLine(line, markers);
    if (!envelope) return;
    if (envelope.kind === "done") {
      if (doneIndex === -1) {
        doneIndex = index;
      }
      return;
    }
    envelopes.push(envelope);
  });

  const promptAfterDone =
    doneIndex === -1
      ? -1
      : lines.findIndex(
          (line, index) =>
            index > doneIndex && resolvedPromptLines.has(line.trim()),
        );

  return {
    done: doneIndex !== -1 && promptAfterDone !== -1,
    envelopes,
  };
}

export function createPromptAwareEnvelopeCollector(
  markers: ExecMarkers,
  promptTokens: readonly string[],
): RuntimeOutputCollector {
  const projector = new Utf8LineProjector();
  const promptLines = new Set(promptTokens.map((token) => token.trim()));
  let sawDone = false;
  let sawPromptAfterDone = false;
  let pending: RuntimeExecEnvelope[] = [];

  const consumeLine = (line: string): void => {
    const envelope = parseEnvelopeLine(line, markers);
    if (envelope?.kind === "done") {
      sawDone = true;
      return;
    }
    if (envelope) {
      pending.push(envelope);
    }
    if (sawDone && promptLines.has(line.trim())) {
      sawPromptAfterDone = true;
    }
  };

  const snapshot = (previewLines: string[]) => {
    const envelopes = pending;
    pending = [];
    return {
      done:
        sawPromptAfterDone ||
        (sawDone && previewLines.some((line) => promptLines.has(line.trim()))),
      envelopes,
    };
  };

  return {
    push(text) {
      for (const line of projector.push(text)) {
        consumeLine(line);
      }
      return snapshot(projector.previewLines());
    },
    finish() {
      for (const line of projector.finish()) {
        consumeLine(line);
      }
      return snapshot([]);
    },
  };
}

function parseEnvelopeLine(
  line: string,
  markers: ExecMarkers,
): RuntimeExecEnvelope | null {
  const prefixIndex = line.indexOf(markers.eventPrefix);
  if (prefixIndex === -1) return null;
  const payload = line.slice(prefixIndex + markers.eventPrefix.length).trim();
  try {
    return parseRuntimeExecEnvelope(JSON.parse(payload));
  } catch {
    // Terminal echo/replay may contain partial or malformed marker-like text.
    return null;
  }
}
