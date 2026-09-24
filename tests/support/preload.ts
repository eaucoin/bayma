// Registered in bunfig.toml: every test runs the runtimes from the payload
// `bun run payload` assembled, which is what an installed bayma runs.
import { afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPayloadEnvironment, PAYLOAD_MANIFEST } from "@bayma/core";
import {
  startTelemetry,
  stopTelemetry,
} from "../../tooling/src/telemetry/index.ts";

const payloadDir = resolve(import.meta.dir, "..", "..", "dist", "payload");
if (existsSync(join(payloadDir, PAYLOAD_MANIFEST))) {
  applyPayloadEnvironment(payloadDir);
  // Servers the tests spawn resolve the same payload rather than downloading.
  process.env.BAYMA_PAYLOAD_DIR = payloadDir;
}

// What the test harness records, such as the output of the servers it starts,
// joins the trace of the command that ran the tests. A preload's afterAll
// runs once, after every test file.
await startTelemetry();
afterAll(stopTelemetry);
