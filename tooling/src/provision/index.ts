import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeId } from "@bayma/core";
import { readJson, writeJson } from "../shared/files.ts";
import { provisionBun } from "./bun.ts";
import { provisionDotnet } from "./dotnet.ts";
import type { ProvisionContext, RuntimePayload } from "./payload.ts";
import { provisionPython } from "./python.ts";
import { provisionRust } from "./rust.ts";

export type { RuntimePayload } from "./payload.ts";

/** What `provision` leaves behind: every payload, by runtime. */
export interface ProvisionRecord {
  provisionedAt: string;
  payloads: Record<RuntimeId, RuntimePayload>;
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
  const record: ProvisionRecord = {
    provisionedAt: new Date().toISOString(),
    payloads: {
      bun: await provisionBun(context),
      python: await provisionPython(context),
      "dotnet-script": await provisionDotnet(context),
      rust: await provisionRust(context),
    },
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
