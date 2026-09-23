// Registered in bunfig.toml: every test runs the runtimes from the payload
// `bun run payload` assembled, which is what an installed bayma runs.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPayloadEnvironment, PAYLOAD_MANIFEST } from "@bayma/core";

const payloadDir = resolve(import.meta.dir, "..", "..", "dist", "payload");
if (existsSync(join(payloadDir, PAYLOAD_MANIFEST))) {
  applyPayloadEnvironment(payloadDir);
  // Servers the tests spawn resolve the same payload rather than downloading.
  process.env.BAYMA_PAYLOAD_DIR = payloadDir;
}
