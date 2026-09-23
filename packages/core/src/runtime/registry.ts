import { aggregateFailure } from "../errors.ts";
import type { RuntimeAdapter } from "./adapter.ts";
import { RUNTIME_IDS, type RuntimeId } from "./id.ts";
import type { RuntimeTransport } from "./transport.ts";

/** One runtime the engine can host: its adapter and the transport it owns. */
export interface RuntimeBinding {
  adapter: RuntimeAdapter;
  transport: RuntimeTransport;
}

/** The runtimes one engine hosts, keyed by id; a session binds to exactly one. */
export class RuntimeRegistry {
  private readonly bindings: ReadonlyMap<RuntimeId, RuntimeBinding>;

  constructor(entries: readonly (RuntimeAdapter | RuntimeBinding)[]) {
    const bindings = new Map<RuntimeId, RuntimeBinding>();
    for (const entry of entries) {
      const binding: RuntimeBinding =
        "adapter" in entry
          ? entry
          : { adapter: entry, transport: entry.createTransport() };
      const { adapter } = binding;
      if (adapter.modelProfile.runtimeId !== adapter.runtimeId) {
        throw new Error(
          `runtime profile ${adapter.modelProfile.runtimeId} does not match adapter ${adapter.runtimeId}`,
        );
      }
      if (bindings.has(adapter.runtimeId)) {
        throw new Error(`duplicate runtime adapter: ${adapter.runtimeId}`);
      }
      bindings.set(adapter.runtimeId, binding);
    }
    if (bindings.size === 0)
      throw new Error("runtime registry requires at least one runtime");
    this.bindings = bindings;
  }

  get(runtimeId: RuntimeId): RuntimeBinding {
    const binding = this.bindings.get(runtimeId);
    if (!binding) throw new Error(`runtime is unavailable: ${runtimeId}`);
    return binding;
  }

  /** Every hosted runtime, in the product's canonical order. */
  list(): RuntimeBinding[] {
    return RUNTIME_IDS.flatMap((runtimeId) => {
      const binding = this.bindings.get(runtimeId);
      return binding ? [binding] : [];
    });
  }

  runtimeIds(): RuntimeId[] {
    return this.list().map(({ adapter }) => adapter.runtimeId);
  }

  /** The runtime to use when a caller names none: only valid with exactly one. */
  onlyRuntimeId(): RuntimeId {
    const runtimeIds = this.runtimeIds();
    if (runtimeIds.length !== 1) {
      throw new Error(
        "runtime must be selected when multiple runtimes are available",
      );
    }
    return runtimeIds[0]!;
  }

  async shutdown(): Promise<void> {
    const outcomes = await Promise.allSettled(
      [...this.bindings.values()].map(({ transport }) => transport.shutdown()),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length > 0)
      throw aggregateFailure("runtime registry shutdown failed", failures);
  }
}
