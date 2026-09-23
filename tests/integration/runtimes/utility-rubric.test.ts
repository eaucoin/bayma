import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNTIME_IDS } from "../../support/runtimes.ts";
import {
  runRuntimeUtilityReport,
  type RuntimeUtilityReport,
} from "./utility-scenarios.ts";

// Every other runtime is judged against Bun on the same scenario corpus; each
// report is written next to the other build outputs.
const REPORT_ROOT = resolve(process.env.BAYMA_REPORT_ROOT ?? "dist/reports");

function writeReport(report: RuntimeUtilityReport): void {
  mkdirSync(REPORT_ROOT, { recursive: true });
  writeFileSync(
    join(REPORT_ROOT, `utility-${report.runtimeId}.json`),
    JSON.stringify(report, null, 2) + "\n",
  );
}

test.serial(
  "every runtime is first-class relative to the Bun baseline",
  async () => {
    const bun = await runRuntimeUtilityReport("bun");
    writeReport(bun);
    expect(bun.failures).toEqual([]);
    expect(bun.recommendation).toBe("baseline");

    for (const runtimeId of RUNTIME_IDS.filter((id) => id !== "bun")) {
      const report = await runRuntimeUtilityReport(runtimeId, bun.latency);
      writeReport(report);
      expect(report.failures).toEqual([]);
      expect(report.recommendation).toBe("ship-candidate");
    }
  },
  600_000,
);
