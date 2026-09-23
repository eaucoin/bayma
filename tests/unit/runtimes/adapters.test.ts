import { expect, test } from "bun:test";
import { createModelSurface, RUNTIME_IDS, RuntimeRegistry } from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { dotnetScriptAdapter } from "@bayma/runtime-dotnet-script";
import { pythonAdapter } from "@bayma/runtime-python";
import { rustAdapter } from "@bayma/runtime-rust";
import { FakeTransport } from "../../support/fake-transport.ts";

const ADAPTERS = [bunAdapter, pythonAdapter, dotnetScriptAdapter, rustAdapter];

test("the four runtime adapters have distinct ids, profiles, and codecs", () => {
  expect(ADAPTERS.map((adapter) => adapter.runtimeId)).toEqual([
    ...RUNTIME_IDS,
  ]);
  expect(new Set(ADAPTERS.map((adapter) => adapter.displayName)).size).toBe(4);
  for (const adapter of ADAPTERS) {
    expect(adapter.modelProfile.runtimeId).toBe(adapter.runtimeId);
    expect(adapter.checkpointCodecs.map((codec) => codec.codecId)).toContain(
      "json-v1",
    );
    expect(adapter.doctor.probeCode).toBe("40 + 2");
  }
});

test("the model surface composes every runtime profile behind one server", () => {
  const bound = (adapters: typeof ADAPTERS) =>
    new RuntimeRegistry(
      adapters.map((adapter) => ({ adapter, transport: new FakeTransport() })),
    );
  const surface = createModelSurface(bound(ADAPTERS), 1_000);
  expect(surface.serverName).toBe("bayma");
  expect(surface.instructions).toContain("selecting exactly one runtime");
  expect(surface.instructions).toContain("defaults to 1000 tokens");
  expect(surface.instructions).toContain("next_seq");
  expect(surface.instructions).toContain("bayma:///sessions");
  for (const adapter of ADAPTERS) {
    expect(surface.instructions).toContain(adapter.modelProfile.heading);
    expect(surface.instructions).toContain(adapter.modelProfile.description);
  }

  const pythonOnly = createModelSurface(bound([pythonAdapter]), 2_000);
  expect(pythonOnly.instructions).toContain("long-lived Python sessions");
  expect(pythonOnly.instructions).not.toContain(
    bunAdapter.modelProfile.description,
  );
});

test("the registry binds each runtime once and rejects a mismatched profile", () => {
  const registry = new RuntimeRegistry(
    ADAPTERS.map((adapter) => ({ adapter, transport: new FakeTransport() })),
  );
  expect(registry.runtimeIds()).toEqual([...RUNTIME_IDS]);
  expect(registry.get("rust").adapter).toBe(rustAdapter);
  expect(() => registry.get("perl" as never)).toThrow(
    "runtime is unavailable: perl",
  );
  expect(() => registry.onlyRuntimeId()).toThrow("runtime must be selected");
  expect(
    new RuntimeRegistry([
      { adapter: bunAdapter, transport: new FakeTransport() },
    ]).onlyRuntimeId(),
  ).toBe("bun");

  expect(() => new RuntimeRegistry([])).toThrow("at least one runtime");
  expect(
    () =>
      new RuntimeRegistry([
        { adapter: bunAdapter, transport: new FakeTransport() },
        { adapter: bunAdapter, transport: new FakeTransport() },
      ]),
  ).toThrow("duplicate runtime adapter: bun");
  expect(
    () =>
      new RuntimeRegistry([
        {
          adapter: { ...bunAdapter, modelProfile: pythonAdapter.modelProfile },
          transport: new FakeTransport(),
        },
      ]),
  ).toThrow("does not match adapter");
});
