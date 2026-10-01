// Registered in bunfig.toml: every test runs the runtimes from the payload
// `bun run payload` assembled, which is what bayma's image carries.
import { afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyPayloadEnvironment,
  installToolbelt,
  PAYLOAD_MANIFEST,
} from "@bayma/core";
import {
  startTelemetry,
  stopTelemetry,
} from "../../tooling/src/telemetry/index.ts";

// What the test harness records, such as the output of the servers it starts,
// joins the trace of the command that ran the tests. Telemetry starts before
// the payload's environment, which leaves telemetry settings out, is applied,
// so the servers the tests start export nothing unless a test configures
// them to.
await startTelemetry();

const payloadDir = resolve(import.meta.dir, "..", "..", "dist", "payload");
if (existsSync(join(payloadDir, PAYLOAD_MANIFEST))) {
  applyPayloadEnvironment(payloadDir);
  // Servers the tests spawn run from the same payload, as the image names its
  // own.
  process.env.BAYMA_PAYLOAD_DIR = payloadDir;
}

// Servers the tests spawn install the payload's toolbelt under the data
// root; a fresh one keeps it out of the real home. It is installed once here,
// so no server a test starts spends the test's time copying it.
const dataHome = mkdtempSync(join(tmpdir(), "bayma-data-"));
process.env.XDG_DATA_HOME = dataHome;
if (process.env.BAYMA_PAYLOAD_DIR)
  installToolbelt(process.env.BAYMA_PAYLOAD_DIR);

// A preload's afterAll runs once, after every test file.
afterAll(async () => {
  await stopTelemetry();
  rmSync(dataHome, { recursive: true, force: true });
});
