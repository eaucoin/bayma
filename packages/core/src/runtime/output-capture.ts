export const RUNTIME_OUTPUT_CAPTURE_POLICY = {
  maxMessageBytes: 65_536,
  maxExecBytes: 4 * 1024 * 1024,
  maxMessages: 4_096,
} as const;

export const RUNTIME_OUTPUT_TRUNCATION_MARKER =
  "…Bayma truncated runtime message…";

const MESSAGE_TRUNCATION_MARKER = Buffer.from(RUNTIME_OUTPUT_TRUNCATION_MARKER);

export interface BoundedRuntimeText {
  text: string;
  truncated: boolean;
  originalByteLength: number;
}

export function boundRuntimeText(
  value: string,
  maxBytes: number = RUNTIME_OUTPUT_CAPTURE_POLICY.maxMessageBytes,
): BoundedRuntimeText {
  const bytes = Buffer.from(value);
  const boundedBytes = Math.max(0, Math.trunc(maxBytes));
  if (bytes.byteLength <= boundedBytes) {
    return {
      text: value,
      truncated: false,
      originalByteLength: bytes.byteLength,
    };
  }
  if (boundedBytes === 0) {
    return { text: "", truncated: true, originalByteLength: bytes.byteLength };
  }
  if (MESSAGE_TRUNCATION_MARKER.byteLength >= boundedBytes) {
    return {
      text: utf8Prefix(MESSAGE_TRUNCATION_MARKER, boundedBytes),
      truncated: true,
      originalByteLength: bytes.byteLength,
    };
  }

  const payloadBytes = boundedBytes - MESSAGE_TRUNCATION_MARKER.byteLength;
  const leftTarget = Math.floor(payloadBytes / 2);
  const rightTarget = bytes.byteLength - (payloadBytes - leftTarget);
  const left = previousUtf8Boundary(bytes, leftTarget);
  const right = nextUtf8Boundary(bytes, rightTarget);
  return {
    text:
      bytes.subarray(0, left).toString("utf8") +
      MESSAGE_TRUNCATION_MARKER.toString("utf8") +
      bytes.subarray(right).toString("utf8"),
    truncated: true,
    originalByteLength: bytes.byteLength,
  };
}

function utf8Prefix(bytes: Buffer, maxBytes: number): string {
  return bytes
    .subarray(0, previousUtf8Boundary(bytes, maxBytes))
    .toString("utf8");
}

function previousUtf8Boundary(bytes: Buffer, target: number): number {
  let boundary = Math.min(Math.max(0, target), bytes.byteLength);
  while (
    boundary > 0 &&
    boundary < bytes.byteLength &&
    isContinuation(bytes[boundary]!)
  ) {
    boundary -= 1;
  }
  return boundary;
}

function nextUtf8Boundary(bytes: Buffer, target: number): number {
  let boundary = Math.min(Math.max(0, target), bytes.byteLength);
  while (boundary < bytes.byteLength && isContinuation(bytes[boundary]!)) {
    boundary += 1;
  }
  return boundary;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
