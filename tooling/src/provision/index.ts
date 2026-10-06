import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeId } from "@bayma/core";
import { readJson, writeJson } from "../shared/files.ts";
import { ATTR } from "../telemetry/attributes.ts";
import { inSpan } from "../telemetry/index.ts";
import { provisionBun } from "./bun.ts";
import { provisionClang } from "./clang.ts";
import { provisionDotnet } from "./dotnet.ts";
import { provisionGo } from "./go.ts";
import { provisionLean } from "./lean.ts";
import type { ProvisionContext, RuntimePayload } from "./payload.ts";
import { provisionPython } from "./python.ts";
import { provisionRust } from "./rust.ts";
import { provisionToolbelt } from "./toolbelt.ts";

export type { RuntimePayload } from "./payload.ts";

/** What `provision` leaves behind: every payload, by runtime, and the toolbelt. */
export interface ProvisionRecord {
  provisionedAt: string;
  payloads: Record<RuntimeId, RuntimePayload>;
  /** The toolbelt directory, built against those runtimes. */
  toolbelt: string;
}

/**
 * Every promise's value, once all have settled, so that no provisioner is
 * still writing into the work directory when another's failure is reported;
 * fails with every failure.
 */
async function settleAll<T extends readonly unknown[]>(promises: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  const results = await Promise.allSettled(promises);
  const failures = results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : result.reason]
      : [],
  );
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return results.map(
    (result) => (result as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
}

export function provisionRecordPath(workDir: string): string {
  return join(workDir, "provision.json");
}

export async function provision(
  repoRoot: string,
  workDir: string,
): Promise<ProvisionRecord> {
  const context: ProvisionContext = {
    repoRoot,
    workDir,
    downloadsDir: join(workDir, "downloads"),
  };
  const step = <T>(name: string, work: () => Promise<T>) =>
    inSpan(`provision ${name}`, { [ATTR.provisionStep]: name }, async () => {
      const started = performance.now();
      const result = await work();
      const seconds = (performance.now() - started) / 1000;
      console.log(`provisioned ${name} in ${seconds.toFixed(1)}s`);
      return result;
    });
  // The runtimes share only the downloads directory, where no two fetch the
  // same archive, and zig, which zig.ts unpacks once for the Rust and Go
  // provisioners both; so they are provisioned side by side. The toolbelt is
  // built against them, after them.
  const [bun, python, dotnet, rust, clang, lean, go] = await settleAll([
    step("bun", () => provisionBun(context)),
    step("python", () => provisionPython(context)),
    step("dotnet-script", () => provisionDotnet(context)),
    step("rust", () => provisionRust(context)),
    step("clang", () => provisionClang(context)),
    step("lean", () => provisionLean(context)),
    step("go", () => provisionGo(context)),
  ]);
  const payloads: Record<RuntimeId, RuntimePayload> = {
    bun,
    python,
    "dotnet-script": dotnet,
    rust,
    ...clang,
    lean,
    go,
  };
  const record: ProvisionRecord = {
    provisionedAt: new Date().toISOString(),
    payloads,
    toolbelt: await step("toolbelt", () =>
      provisionToolbelt(context, payloads),
    ),
  };
  writeJson(provisionRecordPath(workDir), record);
  return record;
}

export function readProvisionRecord(
  workDir: string,
): ProvisionRecord | undefined {
  const path = provisionRecordPath(workDir);
  return existsSync(path) ? readJson<ProvisionRecord>(path) : undefined;
}
