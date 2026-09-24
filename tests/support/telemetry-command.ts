// A development command for tests/tooling/telemetry.test.ts to run in a
// process of its own, with the environment the test chooses, as the CLI runs
// one:
//
//   bun telemetry-command.ts succeed TESTS_DIR
//     runs a process that writes to both streams and prints the trace it
//     was given, one that fails, and the Bun tests in TESTS_DIR, and records
//     an artifact
//   bun telemetry-command.ts fail
//     runs a process that must succeed and does not

import { run, runOrThrow } from "../../tooling/src/shared/process.ts";
import { bunJUnitReport, runTests } from "../../tooling/src/shared/tests.ts";
import {
  inCommand,
  recordArtifact,
  startTelemetry,
  stopTelemetry,
} from "../../tooling/src/telemetry/index.ts";

export const COMMAND = "telemetry-test";
export const ARTIFACT = "telemetry-test artifact";

async function succeed(testsDir: string): Promise<void> {
  await runOrThrow([
    "bun",
    "-e",
    [
      'console.log("to stdout");',
      'console.error("to stderr");',
      'console.log("traceparent " + process.env.TRACEPARENT);',
    ].join(" "),
  ]);
  await run(["bun", "-e", "process.exit(3)"]);
  await runTests("bun", ["bun", "test"], bunJUnitReport, { cwd: testsDir });
  recordArtifact(ARTIFACT, 1234);
}

async function fail(): Promise<void> {
  await runOrThrow(["bun", "-e", "process.exit(4)"]);
}

if (import.meta.main) {
  const [mode, testsDir] = process.argv.slice(2);
  const work =
    mode === "fail"
      ? fail
      : mode === "succeed" && testsDir
        ? () => succeed(testsDir)
        : undefined;
  if (!work)
    throw new Error("usage: bun telemetry-command.ts succeed TESTS_DIR | fail");
  await startTelemetry();
  try {
    await inCommand(COMMAND, work);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await stopTelemetry();
  }
}
