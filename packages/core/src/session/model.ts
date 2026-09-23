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

export interface SessionDetail extends SessionSummary {
  activeExecId?: string;
  queuedExecIds: string[];
  latestExecId?: string;
  execCount: number;
}
