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
  /**
   * When the last exec ended, or the server started if none has since;
   * null while any is running or queued.
   */
  idleSinceMs: number | null;
}

export interface SessionDetail extends SessionSummary {
  activeExecId?: string;
  queuedExecIds: string[];
  latestExecId?: string;
  execCount: number;
}
