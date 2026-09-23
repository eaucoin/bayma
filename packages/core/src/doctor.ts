import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { aggregateFailure } from "./errors.ts";
import type { RuntimeAdapter } from "./runtime/adapter.ts";
import type { RuntimeId } from "./runtime/id.ts";
import { createEngine, type Engine } from "./engine.ts";

// `doctor` proves that every selected runtime can create a session and
// execute its probe, through the same engine the servers use.

export interface DoctorOptions {
  cwd: string;
  stateDir?: string;
  outputFormat?: "text" | "json";
}

export const DOCTOR_RESULT_SCHEMA_VERSION = 1 as const;
const PROBE_TIMEOUT_MS = 60_000;

export function doctorSuccessOutput(runtimeIds: readonly RuntimeId[]): string {
  return JSON.stringify({
    schemaVersion: DOCTOR_RESULT_SCHEMA_VERSION,
    status: "passed",
    runtimes: runtimeIds,
  });
}

export function assertDoctorProcessResult(
  runtimeIds: readonly RuntimeId[],
  result: { status: number; stdout: string; stderr: string },
): void {
  if (
    result.status !== 0 ||
    result.stdout !== doctorSuccessOutput(runtimeIds) + "\n" ||
    result.stderr !== ""
  ) {
    throw new Error("doctor process did not emit its exact success record");
  }
}

async function probe(
  engine: Engine,
  adapter: RuntimeAdapter,
  actorId: string,
  cwd: string,
): Promise<string> {
  const session = await engine.manager.create(
    actorId,
    `doctor ${adapter.displayName}`,
    cwd,
    "controller",
    adapter.runtimeId,
  );
  const { execId } = await engine.manager.submitExec(
    session.sessionId,
    actorId,
    adapter.doctor.probeCode,
  );
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exec = engine.manager.exec(session.sessionId, execId);
    if (exec.status === "ok") {
      adapter.doctor.assertSuccess(exec);
      return session.sessionId;
    }
    if (exec.status === "error" || exec.status === "interrupted") {
      throw new Error(
        `${adapter.runtimeId} doctor exec ended with status ${exec.status}`,
      );
    }
    await sleep(25);
  }
  throw new Error(`${adapter.runtimeId} doctor exec timed out`);
}

export async function runDoctor(
  adapters: readonly RuntimeAdapter[],
  options: DoctorOptions,
): Promise<void> {
  const stateDir =
    options.stateDir ?? mkdtempSync(join(tmpdir(), "bayma-doctor-"));
  const cleanupStateDir = options.stateDir === undefined;
  const actorId = "doctor";
  const runtimeIds = adapters.map(({ runtimeId }) => runtimeId);

  let engine: Engine | undefined;
  let engineShutdownSucceeded = false;
  const doctorSessionIds: string[] = [];
  let operationError: unknown;
  try {
    engine = await createEngine(
      adapters,
      {
        stateDir: resolve(stateDir),
        maxSessions: Math.max(4, adapters.length),
        warnUsagePercent: 75,
        defaultCols: 120,
        defaultRows: 40,
      },
      () => undefined,
    );
    for (const adapter of adapters) {
      doctorSessionIds.push(
        await probe(engine, adapter, actorId, resolve(options.cwd)),
      );
    }
  } catch (error) {
    operationError = error;
  }

  // Only the sessions this invocation created are closed; a caller-supplied
  // state directory may hold durable sessions that are not ours to touch.
  const cleanupFailures: unknown[] = [];
  if (engine) {
    for (const sessionId of doctorSessionIds) {
      if (!engine.manager.list().some((entry) => entry.sessionId === sessionId))
        continue;
      try {
        await engine.manager.close(sessionId, actorId);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await engine.shutdown();
      engineShutdownSucceeded = true;
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupStateDir && engineShutdownSucceeded) {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  if (operationError !== undefined) {
    if (cleanupFailures.length > 0) {
      throw aggregateFailure("doctor failed and cleanup was incomplete", [
        operationError,
        ...cleanupFailures,
      ]);
    }
    throw operationError;
  }
  if (cleanupFailures.length > 0)
    throw aggregateFailure("doctor cleanup failed", cleanupFailures);
  console.log(
    options.outputFormat === "json"
      ? doctorSuccessOutput(runtimeIds)
      : `ok: Bayma passed for ${runtimeIds.join(", ")}`,
  );
}
