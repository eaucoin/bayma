import type { ActorId, SessionRole, SessionStatus } from "./model.ts";
import type { ExecStatus } from "./exec-types.ts";

export type SessionEvent =
  | { type: "session/started"; sessionId: string; status: SessionStatus }
  | {
      type: "session/actorJoined";
      sessionId: string;
      role: SessionRole;
      actorId: ActorId;
    }
  | { type: "session/actorLeft"; sessionId: string; actorId: ActorId }
  | {
      type: "session/statusChanged";
      sessionId: string;
      status: SessionStatus;
      reason?: string;
    }
  | {
      type: "session/recoveryStarted";
      sessionId: string;
      runtimeGeneration: number;
    }
  | {
      type: "session/recoveryFinished";
      sessionId: string;
      runtimeGeneration: number;
    }
  | { type: "session/quarantined"; sessionId: string; reason: string }
  | {
      type: "session/checkpointCommitted";
      sessionId: string;
      checkpointRevision: string;
      codecId?: string;
      byteLength?: number;
    }
  | {
      type: "session/checkpointFailed";
      sessionId: string;
      execId?: string;
      reason: string;
    }
  | {
      type: "session/runtimeRecycled";
      sessionId: string;
      runtimeGeneration: number;
      reason: string;
    }
  | { type: "session/controllerChanged"; sessionId: string; actorId?: ActorId }
  | {
      type: "session/pressureWarning";
      liveSessions: number;
      maxSessions: number;
    }
  | { type: "session/evictionScheduled"; sessionId: string; reason: string }
  | { type: "session/closed"; sessionId: string; reason: string }
  | {
      type: "exec/started";
      sessionId: string;
      execId: string;
      startedAtMs: number;
    }
  | {
      type: "exec/ptyDelta";
      sessionId: string;
      execId: string;
      seq: number;
      channel: "pty";
      dataBase64: string;
    }
  | {
      type: "exec/stdout";
      sessionId: string;
      execId: string;
      seq: number;
      messageId: string;
      text: string;
    }
  | {
      type: "exec/stderr";
      sessionId: string;
      execId: string;
      seq: number;
      messageId: string;
      text: string;
    }
  | {
      type: "exec/result";
      sessionId: string;
      execId: string;
      seq: number;
      messageId: string;
      text: string;
    }
  | {
      type: "exec/error";
      sessionId: string;
      execId: string;
      seq: number;
      messageId: string;
      text: string;
    }
  | {
      type: "exec/finished";
      sessionId: string;
      execId: string;
      status: Extract<ExecStatus, "ok" | "error" | "interrupted">;
      durationMs: number;
      messageCount: number;
    };

export interface SessionEventEnvelope {
  actorIds: ActorId[];
  event: SessionEvent;
}

export type SessionEventSink = (envelope: SessionEventEnvelope) => void;

export interface SessionEventRecord {
  seq: number;
  occurredAtMs: number;
  event: SessionEvent;
}
