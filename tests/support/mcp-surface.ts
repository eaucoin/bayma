import { expect } from "bun:test";
import { SERVER_EVENTS_URI, SESSIONS_URI } from "@bayma/core";

// The complete MCP surface every bayma server exposes. Asserted exactly, so a
// tool or resource cannot appear or disappear without a test changing.

export const MCP_TOOLS = [
  "session.create",
  "session.acquire_controller",
  "session.release_controller",
  "exec",
  "wait",
  "session.interrupt",
  "session.resize",
  "session.close",
] as const;

export const MCP_RESOURCE_TEMPLATES = [
  "bayma:///session/{sessionId}",
  "bayma:///session/{sessionId}/exec/{execId}",
  "bayma:///session/{sessionId}/exec/{execId}/messages",
] as const;

export const MCP_FIXED_RESOURCES = [SESSIONS_URI, SERVER_EVENTS_URI] as const;

const DYNAMIC_RESOURCE_URI =
  /^bayma:\/\/\/session\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:\/exec\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:\/messages)?)?$/;

export function expectExactMcpSurface(surface: {
  tools: readonly string[];
  resourceTemplates: readonly string[];
  resources: readonly string[];
}): void {
  expect([...surface.tools].sort()).toEqual([...MCP_TOOLS].sort());
  expect([...surface.resourceTemplates].sort()).toEqual(
    [...MCP_RESOURCE_TEMPLATES].sort(),
  );
  expect(new Set(surface.resources).size).toBe(surface.resources.length);
  const fixed = surface.resources.filter((uri) =>
    (MCP_FIXED_RESOURCES as readonly string[]).includes(uri),
  );
  expect([...fixed].sort()).toEqual([...MCP_FIXED_RESOURCES].sort());
  const dynamic = surface.resources.filter((uri) => !fixed.includes(uri));
  expect(dynamic.filter((uri) => !DYNAMIC_RESOURCE_URI.test(uri))).toEqual([]);
}
