import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTR } from "../telemetry/attributes.ts";
import { inSpan, recordTests, telemetryEnabled } from "../telemetry/index.ts";
import { readJUnit } from "../telemetry/junit.ts";
import { run, type RunOptions, type RunResult } from "./process.ts";

/** The arguments that make `bun test` write a JUnit report to `path`. */
export function bunJUnitReport(path: string): string[] {
  return ["--reporter=junit", `--reporter-outfile=${path}`];
}

/**
 * Runs a test suite with `runner`. With telemetry on, the runner also writes
 * a JUnit report, to the path `report` makes arguments of, and every result
 * in it is recorded, failures included, before the run's result is returned.
 */
export async function runTests(
  runner: string,
  command: string[],
  report: (path: string) => string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (!telemetryEnabled()) return run(command, options);
  return inSpan(`test ${runner}`, { [ATTR.testRunner]: runner }, async () => {
    const directory = mkdtempSync(join(tmpdir(), "bayma-junit-"));
    try {
      const path = join(directory, "report.xml");
      const result = await run([...command, ...report(path)], options);
      if (existsSync(path)) recordTests(runner, readJUnit(path));
      return result;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
