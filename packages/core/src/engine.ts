import { resolve } from "node:path";
import { aggregateFailure } from "./errors.ts";
import type { RuntimeAdapter } from "./runtime/adapter.ts";
import { RuntimeRegistry, type RuntimeBinding } from "./runtime/registry.ts";
import type { SessionEventSink } from "./session/events.ts";
import { SessionCatalogStore } from "./session/catalog-store.ts";
import { ExecHistoryStore } from "./session/exec-history-store.ts";
import { CheckpointStore } from "./session/checkpoint-store.ts";
import {
  SessionManager,
  validateSessionManagerOptions,
  type SessionManagerOptions,
} from "./session/session-manager.ts";
import { removeAllExecFileWorkspaces } from "./runtime/exec-files.ts";
import {
  acquireStateDirectoryLease,
  type StateDirectoryLease,
} from "./runtime/state-directory-lease.ts";

// If initialization cannot prove that its transport stopped, retaining the
// lease until process exit is safer than allowing another runtime to mutate
// the same state beside a potentially live transport.
const unsafeInitializationLeasesHeldUntilExit = new Set<StateDirectoryLease>();

export interface EngineConfig extends SessionManagerOptions {
  stateDir: string;
}

export interface Engine {
  registry: RuntimeRegistry;
  manager: SessionManager;
  catalogStore: SessionCatalogStore;
  historyStore: ExecHistoryStore;
  checkpointStore: CheckpointStore;
  shutdown: () => Promise<void>;
}

export async function createEngine(
  runtimes: readonly (RuntimeAdapter | RuntimeBinding)[],
  config: EngineConfig,
  emit: SessionEventSink,
): Promise<Engine> {
  validateSessionManagerOptions(config);
  const lease = await acquireStateDirectoryLease(resolve(config.stateDir));
  const rootDir = lease.stateDir;
  let registry: RuntimeRegistry | undefined;
  let catalogStore: SessionCatalogStore;
  let historyStore: ExecHistoryStore;
  let checkpointStore: CheckpointStore;
  let manager: SessionManager;
  try {
    registry = new RuntimeRegistry(runtimes);
    catalogStore = new SessionCatalogStore(rootDir);
    historyStore = new ExecHistoryStore(rootDir);
    checkpointStore = new CheckpointStore(rootDir);
    removeAllExecFileWorkspaces(historyStore.execBundlesDir);
    manager = new SessionManager(
      registry,
      catalogStore,
      historyStore,
      checkpointStore,
      config,
      emit,
    );
    await manager.loadCatalog();
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    let registryStopped = registry === undefined;
    if (registry) {
      try {
        await registry.shutdown();
        registryStopped = true;
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (registryStopped) {
      try {
        await lease.release();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    } else {
      unsafeInitializationLeasesHeldUntilExit.add(lease);
    }
    if (cleanupFailures.length > 0) {
      throw aggregateFailure(
        "Bayma catalog load failed and transport cleanup was incomplete",
        [error, ...cleanupFailures],
      );
    }
    throw error;
  }
  return {
    registry,
    manager,
    catalogStore,
    historyStore,
    checkpointStore,
    shutdown: async () => {
      await manager.shutdown();
      await lease.release();
    },
  };
}
