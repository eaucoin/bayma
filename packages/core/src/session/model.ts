import type { RuntimeId } from "../runtime/id.ts";

export type ActorId = string;

export const SESSION_STATUSES = [
  "live_idle",
  "live_busy",
  "suspended",
  "recovering",
  "quarantined",
  "closed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export type SessionRole = "controller" | "observer";
export const DURABILITY_MODES = ["ephemeral", "checkpointed"] as const;
export type DurabilityMode = (typeof DURABILITY_MODES)[number];

export interface SessionSummary {
  sessionId: string;
  runtimeId?: RuntimeId;
  title: string;
  cwd: string;
  status: SessionStatus;
  quarantineReason?: string;
  createdAtMs: number;
  updatedAtMs: number;
  controllerActorId?: ActorId;
  observerActorIds: ActorId[];
  historyLength: number;
}

/**
 * The execs clients submitted that have not ended, across every session: what
 * a host that runs bayma releases it on, once none is left.
 */
export interface ExecActivity {
  execsRunning: number;
  execsQueued: number;
  /** Those running, each by its session's and its own ID. */
  running: { sessionId: string; execId: string }[];
  /**
   * When the last exec ended, or the server started if none has since;
   * null while any is running or queued.
   */
  idleSinceMs: number | null;
  /**
   * The state directory's generation (see StateGeneration): a save of the
   * sandbox that caught another may no longer be restored.
   */
  generation: number;
}

/**
 * What a save of the sandbox caught, as `sandbox-hook save` says it: the
 * state generation, which it may be restored at only while it is the one on
 * the disk, and the execs that ran, each by its session's and its own ID.
 */
export interface SandboxSave {
  generation: number;
  running: { sessionId: string; execId: string }[];
}

export interface SessionDetail extends SessionSummary {
  activeExecId?: string;
  queuedExecIds: string[];
  latestExecId?: string;
  execCount: number;
}
