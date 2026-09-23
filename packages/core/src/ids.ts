import { randomUUID } from "node:crypto";

export const SAFE_PERSISTED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function createOpaqueId(prefix: string): string {
  if (typeof prefix !== "string" || !/^[a-z][a-z0-9_]{0,94}$/.test(prefix)) {
    throw new Error(`invalid opaque ID prefix: ${prefix}`);
  }
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function assertSafePersistedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_PERSISTED_ID_PATTERN.test(value)) {
    throw new Error(`invalid persisted ${label}: ${value}`);
  }
  return value;
}
