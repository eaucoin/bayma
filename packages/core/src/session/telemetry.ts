import { context, type Attributes, type Context } from "@opentelemetry/api";
import {
  counter,
  histogram,
  inSpan,
  log,
  markFailed,
  observeGauge,
  SeverityNumber,
} from "../telemetry/record.ts";
import type { SessionEvent } from "./events.ts";
import type { ExecRecord } from "./exec-types.ts";
import type { SessionSummary } from "./model.ts";

// What the session manager records: a span for each part of its work that
// takes time, an exec, a runtime starting, a session recovering, its runtime
// coming back from or going into a process snapshot, and how long the
// first three took; and, from the events it raises, log records and counts
// of what befell sessions.

/** A session's identity, as attributes name it. */
interface SessionIdentity {
  sessionId: string;
  runtimeId?: string;
}

/** How a session came back: whole from its process snapshot, or from its checkpoint. */
export type RecoverySource = "process_snapshot" | "checkpoint";

/** Seconds, from a quick exec to an hour-long one. */
const RUN_SECONDS = [
  0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800, 3600,
];
/** Bytes, from a kilobyte to the checkpoint store's 64 MiB limit. */
const CHECKPOINT_BYTES = [1e3, 1e4, 1e5, 1e6, 1e7, 1e8];

const execDuration = histogram("bayma.exec.duration", {
  unit: "s",
  description:
    "How long a client's exec ran, from starting in its runtime to ending.",
  advice: { explicitBucketBoundaries: RUN_SECONDS },
});
const runtimeStartDuration = histogram("bayma.runtime.start.duration", {
  unit: "s",
  description: "How long a session's runtime took to start and answer.",
  advice: { explicitBucketBoundaries: RUN_SECONDS },
});
const recoveryDuration = histogram("bayma.session.recovery.duration", {
  unit: "s",
  description:
    "How long a session took to come back after the server that ran it stopped.",
  advice: { explicitBucketBoundaries: RUN_SECONDS },
});
const checkpointSize = histogram("bayma.checkpoint.size", {
  unit: "By",
  description: "The size of a checkpoint a session committed.",
  advice: { explicitBucketBoundaries: CHECKPOINT_BYTES },
});
const checkpointCommits = counter("bayma.checkpoint.commits", {
  description: "Checkpoints sessions committed, or failed to commit.",
});
const quarantines = counter("bayma.session.quarantines", {
  description: "Sessions quarantined.",
});
const evictions = counter("bayma.session.evictions", {
  description: "Sessions evicted to make room for another.",
});

/** A session's identity and runtime, as attributes. */
export function sessionAttributes(session: SessionIdentity): Attributes {
  return {
    "bayma.session.id": session.sessionId,
    ...(session.runtimeId ? { "bayma.runtime": session.runtimeId } : {}),
  };
}

/** The runtime alone: what a metric is labelled with, never the session. */
function runtimeLabel(session: SessionIdentity): Attributes {
  return session.runtimeId ? { "bayma.runtime": session.runtimeId } : {};
}

/**
 * Runs `work` and records how long it took in `duration`, labelled by
 * `labels` from its result, and with its error's type when it throws.
 */
async function timed<T>(
  duration: ReturnType<typeof histogram>,
  labels: (result: T | undefined) => Attributes,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let result: T | undefined;
  let errorType: string | undefined;
  try {
    result = await work();
    return result;
  } catch (error) {
    errorType = error instanceof Error ? error.name : "Error";
    throw error;
  } finally {
    duration.record((performance.now() - startedAt) / 1000, {
      ...labels(result),
      ...(errorType === undefined ? {} : { "error.type": errorType }),
    });
  }
}

const submissions = new WeakMap<ExecRecord, Context>();

/** Remembers the trace an exec is submitted in, for it to run in later. */
export function rememberSubmission(record: ExecRecord): void {
  submissions.set(record, context.active());
}

/**
 * Runs an exec as the span `bayma.exec`, in the trace it was submitted in,
 * and measures one a client submitted; bayma's own, which restore and
 * recover sessions, are `bayma.exec.internal`. An exec ending in an error is
 * its code's failure, not bayma's, told by `bayma.exec.status` alone.
 */
export async function traceExec(
  session: SessionIdentity,
  record: ExecRecord,
  internal: boolean,
  work: () => Promise<void>,
): Promise<void> {
  const traced = () =>
    inSpan(
      "bayma.exec",
      {
        ...sessionAttributes(session),
        "bayma.exec.id": record.execId,
        ...(internal ? { "bayma.exec.internal": true } : {}),
      },
      async (span) => {
        await work();
        span.setAttribute("bayma.exec.status", record.status);
      },
      { parent: submissions.get(record) },
    );
  if (internal) return traced();
  return timed(
    execDuration,
    () => ({ ...runtimeLabel(session), "bayma.exec.status": record.status }),
    traced,
  );
}

/** Starts a session's runtime as the span `bayma.runtime.start`, measured. */
export async function traceRuntimeStart(
  session: SessionIdentity,
  reason: "create" | "recovery" | "recycle",
  work: () => Promise<void>,
): Promise<void> {
  const attributes = { "bayma.runtime.start.reason": reason };
  return timed(
    runtimeStartDuration,
    () => ({ ...runtimeLabel(session), ...attributes }),
    () =>
      inSpan(
        "bayma.runtime.start",
        { ...sessionAttributes(session), ...attributes },
        work,
      ),
  );
}

/**
 * Brings a session back as the span `bayma.session.recover`, measured, and
 * labelled with how it came back.
 */
export async function traceRecovery(
  session: SessionIdentity,
  work: () => Promise<RecoverySource>,
): Promise<void> {
  await timed(
    recoveryDuration,
    (source) => ({
      ...runtimeLabel(session),
      ...(source ? { "bayma.session.recovery.source": source } : {}),
    }),
    () =>
      inSpan(
        "bayma.session.recover",
        sessionAttributes(session),
        async (span) => {
          const source = await work();
          span.setAttribute("bayma.session.recovery.source", source);
          return source;
        },
      ),
  );
}

/**
 * Restores a session's runtime from its process snapshot as the span
 * `bayma.runtime.restore`; `work` returns why it could not, if it could not.
 */
export async function traceRestore(
  session: SessionIdentity,
  work: () => Promise<string | undefined>,
): Promise<string | undefined> {
  return inSpan(
    "bayma.runtime.restore",
    sessionAttributes(session),
    async (span) => {
      const unrestored = await work();
      if (unrestored !== undefined) markFailed(span, unrestored);
      return unrestored;
    },
  );
}

/** Dumps a session's runtime to a process snapshot as the span `bayma.runtime.snapshot`. */
export async function traceSnapshot<T>(
  session: SessionIdentity,
  work: () => Promise<T>,
): Promise<T> {
  return inSpan("bayma.runtime.snapshot", sessionAttributes(session), work);
}

/** A log record of a session event worth an operator's notice. */
function record(
  severity: SeverityNumber,
  body: string,
  event: SessionEvent,
  session: SessionIdentity | undefined,
  attributes: Attributes = {},
): void {
  log(
    severity,
    body,
    { ...(session ? sessionAttributes(session) : {}), ...attributes },
    `bayma.${event.type.replace("/", ".")}`,
  );
}

/**
 * Records what an event the session manager raised tells an operator, of
 * `session`, which it concerns when it concerns one: a log record, a count,
 * or both. Events an exec's or a client's every step raises are left to the
 * spans.
 */
export function observeSessionEvent(
  event: SessionEvent,
  session: SessionIdentity | undefined,
): void {
  const label = session ? runtimeLabel(session) : {};
  switch (event.type) {
    case "session/started":
      record(
        SeverityNumber.INFO,
        `session ${event.sessionId} started`,
        event,
        session,
      );
      return;
    case "session/closed":
      record(
        SeverityNumber.INFO,
        `session ${event.sessionId} closed: ${event.reason}`,
        event,
        session,
      );
      return;
    case "session/recoveryStarted":
    case "session/recoveryFinished":
      record(
        SeverityNumber.INFO,
        `session ${event.sessionId} ${event.type === "session/recoveryStarted" ? "is recovering" : "recovered"}`,
        event,
        session,
        { "bayma.runtime.generation": event.runtimeGeneration },
      );
      return;
    case "session/runtimeRecycled":
      record(
        SeverityNumber.INFO,
        `session ${event.sessionId}'s runtime was recycled: ${event.reason}`,
        event,
        session,
      );
      return;
    case "session/quarantined":
      quarantines.add(1, label);
      record(
        SeverityNumber.WARN,
        `session ${event.sessionId} was quarantined: ${event.reason}`,
        event,
        session,
      );
      return;
    case "session/checkpointCommitted":
      checkpointCommits.add(1, {
        ...label,
        "bayma.checkpoint.outcome": "committed",
      });
      if (event.byteLength !== undefined)
        checkpointSize.record(event.byteLength, label);
      return;
    case "session/checkpointFailed":
      checkpointCommits.add(1, {
        ...label,
        "bayma.checkpoint.outcome": "failed",
      });
      record(
        SeverityNumber.WARN,
        `session ${event.sessionId} did not commit its checkpoint: ${event.reason}`,
        event,
        session,
      );
      return;
    case "session/evictionScheduled":
      evictions.add(1, label);
      record(
        SeverityNumber.INFO,
        `session ${event.sessionId} is evicted: ${event.reason}`,
        event,
        session,
      );
      return;
    case "session/pressureWarning":
      record(
        SeverityNumber.WARN,
        `${event.liveSessions} of at most ${event.maxSessions} sessions are live`,
        event,
        session,
      );
      return;
  }
}

/**
 * Reports how many sessions there are, by status and runtime, whenever
 * metrics are read. Returns what stops it.
 */
export function observeSessions(list: () => SessionSummary[]): () => void {
  return observeGauge(
    "bayma.session.count",
    {
      unit: "{session}",
      description: "Sessions this server holds, by status.",
    },
    (result) => {
      const counts = new Map<
        string,
        { attributes: Attributes; count: number }
      >();
      for (const session of list()) {
        const key = `${session.status}\0${session.runtimeId ?? ""}`;
        const entry = counts.get(key) ?? {
          attributes: {
            "bayma.session.status": session.status,
            ...runtimeLabel(session),
          },
          count: 0,
        };
        entry.count += 1;
        counts.set(key, entry);
      }
      for (const { attributes, count } of counts.values())
        result.observe(count, attributes);
    },
  );
}
