const APPROX_BYTES_PER_TOKEN = 4;
export const TRUNCATION_MARKER_MAX_BYTES = 64;

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalTokenCount?: number;
}

export function approxBytesForTokens(tokens: number): number {
  return Math.max(0, Math.trunc(tokens)) * APPROX_BYTES_PER_TOKEN;
}

interface CharacterBoundary {
  codeUnitIndex: number;
  codeUnitLength: number;
  byteStart: number;
  byteEnd: number;
}

export function approxTokenCount(text: string): number {
  const byteLength = Buffer.byteLength(text, "utf8");
  return Math.floor(
    (byteLength + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN,
  );
}

export function formattedTruncateText(
  content: string,
  maxTokens: number,
): TruncatedText {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (
    Buffer.byteLength(normalized, "utf8") <= approxBytesForTokens(maxTokens)
  ) {
    return { text: normalized, truncated: false };
  }

  const truncated = truncateWithTokenBudget(normalized, maxTokens);
  return {
    text: `Total output lines: ${countLines(normalized)}\n\n${truncated}`,
    truncated: truncated !== normalized,
    originalTokenCount: approxTokenCount(normalized),
  };
}

export function truncateTextToByteBudget(
  content: string,
  maxBytes: number,
): TruncatedText {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const boundedBytes = Math.max(0, Math.trunc(maxBytes));
  if (Buffer.byteLength(normalized, "utf8") <= boundedBytes) {
    return { text: normalized, truncated: false };
  }
  return {
    text: truncateWithByteBudget(normalized, boundedBytes),
    truncated: true,
    originalTokenCount: approxTokenCount(normalized),
  };
}

function truncateWithTokenBudget(content: string, maxTokens: number): string {
  if (content.length === 0) return "";
  const byteLength = Buffer.byteLength(content, "utf8");
  if (maxTokens > 0 && byteLength <= approxBytesForTokens(maxTokens)) {
    return content;
  }
  return truncateWithByteEstimate(content, maxTokens);
}

function truncateWithByteEstimate(content: string, maxTokens: number): string {
  return truncateWithByteBudget(content, approxBytesForTokens(maxTokens));
}

function truncateWithByteBudget(content: string, maxBytes: number): string {
  if (content.length === 0) return "";

  const totalBytes = Buffer.byteLength(content, "utf8");
  if (maxBytes === 0) {
    return formatTruncationMarker(approxTokensFromByteCount(totalBytes));
  }
  if (totalBytes <= maxBytes) {
    return content;
  }

  const [leftBudget, rightBudget] = splitBudget(maxBytes);
  const { before, after } = splitString(content, leftBudget, rightBudget);
  const retainedBytes =
    Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8");
  const removedBytes = totalBytes - retainedBytes;
  return `${before}${formatTruncationMarker(approxTokensFromByteCount(removedBytes))}${after}`;
}

function splitBudget(budget: number): [number, number] {
  const left = Math.floor(budget / 2);
  return [left, budget - left];
}

function splitString(
  content: string,
  beginningBytes: number,
  endBytes: number,
): {
  before: string;
  after: string;
} {
  if (content.length === 0) {
    return { before: "", after: "" };
  }

  const boundaries = collectCharacterBoundaries(content);
  const totalBytes = boundaries.at(-1)?.byteEnd ?? 0;
  const tailStartTarget = Math.max(0, totalBytes - endBytes);
  let prefixEnd = 0;
  let suffixStart = content.length;
  let suffixStarted = false;

  for (const boundary of boundaries) {
    if (boundary.byteEnd <= beginningBytes) {
      prefixEnd = boundary.codeUnitIndex + boundary.codeUnitLength;
      continue;
    }

    if (boundary.byteStart >= tailStartTarget) {
      if (!suffixStarted) {
        suffixStart = boundary.codeUnitIndex;
        suffixStarted = true;
      }
      continue;
    }
  }

  if (suffixStart < prefixEnd) {
    suffixStart = prefixEnd;
  }

  return {
    before: content.slice(0, prefixEnd),
    after: content.slice(suffixStart),
  };
}

function collectCharacterBoundaries(content: string): CharacterBoundary[] {
  const boundaries: CharacterBoundary[] = [];
  let codeUnitIndex = 0;
  let byteIndex = 0;

  for (const character of content) {
    const codeUnitLength = character.length;
    const byteLength = Buffer.byteLength(character, "utf8");
    boundaries.push({
      codeUnitIndex,
      codeUnitLength,
      byteStart: byteIndex,
      byteEnd: byteIndex + byteLength,
    });
    codeUnitIndex += codeUnitLength;
    byteIndex += byteLength;
  }

  return boundaries;
}

function formatTruncationMarker(removedTokenCount: number): string {
  return `…${removedTokenCount} tokens truncated…`;
}

function approxTokensFromByteCount(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.floor(
    (bytes + APPROX_BYTES_PER_TOKEN - 1) / APPROX_BYTES_PER_TOKEN,
  );
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts.length;
}
