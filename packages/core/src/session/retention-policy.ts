export interface SessionSnapshot {
  sessionId: string;
  createdAtMs: number;
  busy: boolean;
  controllerActorId?: string;
  status:
    | "live_idle"
    | "live_busy"
    | "suspended"
    | "recovering"
    | "quarantined"
    | "closed";
}

export interface RetentionPolicy {
  maxSessions: number;
  warnUsagePercent: number;
}

export function validateRetentionPolicy(policy: RetentionPolicy): void {
  if (!Number.isSafeInteger(policy.maxSessions) || policy.maxSessions < 1) {
    throw new Error("maxSessions must be a positive safe integer");
  }
  if (
    !Number.isFinite(policy.warnUsagePercent) ||
    policy.warnUsagePercent < 0 ||
    policy.warnUsagePercent > 100
  ) {
    throw new Error("warnUsagePercent must be between 0 and 100");
  }
}

export function warningThreshold(policy: RetentionPolicy): number {
  validateRetentionPolicy(policy);
  return Math.max(
    1,
    Math.ceil((policy.maxSessions * policy.warnUsagePercent) / 100),
  );
}

export function shouldWarn(
  policy: RetentionPolicy,
  liveSessionCount: number,
): boolean {
  return liveSessionCount >= warningThreshold(policy);
}

export function pickEvictionCandidate(
  sessions: SessionSnapshot[],
): SessionSnapshot | null {
  const evictableIdle = sessions
    .filter(
      (session) =>
        !session.busy &&
        !session.controllerActorId &&
        session.status === "live_idle",
    )
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
  return evictableIdle[0] ?? null;
}
