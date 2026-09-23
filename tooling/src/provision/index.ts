import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeId } from "@bayma/core";
import { readJson, writeJson } from "../shared/files.ts";
import { provisionBun } from "./bun.ts";
import { provisionClang } from "./clang.ts";
import { provisionDotnet } from "./dotnet.ts";
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
  const payloads: Record<RuntimeId, RuntimePayload> = {
    bun: await provisionBun(context),
    python: await provisionPython(context),
    "dotnet-script": await provisionDotnet(context),
    rust: await provisionRust(context),
    ...(await provisionClang(context)),
  };
  const record: ProvisionRecord = {
    provisionedAt: new Date().toISOString(),
    payloads,
    toolbelt: await provisionToolbelt(context, payloads),
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
