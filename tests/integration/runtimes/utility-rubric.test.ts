import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  runRuntimeUtilityReport,
  type RuntimeUtilityReport,
} from "./utility-scenarios.ts";

// Python, dotnet-script, and Rust are judged against Bun on the same scenario
// corpus; each report is written next to the other build outputs.
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
    expect(bun.failures).toHaveLength(0);
    expect(bun.recommendation).toBe("baseline");

    for (const runtimeId of ["python", "dotnet-script", "rust"] as const) {
      const report = await runRuntimeUtilityReport(runtimeId, bun.latency);
      writeReport(report);
      expect(report.failures).toHaveLength(0);
      expect(report.recommendation).toBe("ship-candidate");
    }
  },
  600_000,
);
