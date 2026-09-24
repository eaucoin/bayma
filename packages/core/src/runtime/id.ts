// The language runtimes bayma can host. Order is presentation order.
export const RUNTIME_IDS = [
  "bun",
  "python",
  "dotnet-script",
  "rust",
  "c",
  "cpp",
  "lean",
  "go",
] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export function isRuntimeId(value: string): value is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(value);
}

export function parseRuntimeId(value: string): RuntimeId {
  if (!isRuntimeId(value)) throw new Error(`unsupported runtime: ${value}`);
  return value;
}
