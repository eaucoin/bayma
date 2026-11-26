// A development command for tests/unit/core/runtime/payload.test.ts to run in
// a process of its own, as applying a payload changes the process's
// environment and what its sessions' starts look at:
//
//   bun payload-runtime-command.ts PAYLOAD STATE_DIR STEP...
//
// applies PAYLOAD, then takes each STEP in turn, printing a JSON line for each:
//   env:NAME        what the environment holds of NAME
//   prepare:RUNTIME readies RUNTIME's files (preparePayloadRuntime)
//   create:bun      creates a Bun session of a session manager in STATE_DIR,
//                   whose transport only counts its starts
//   rm:PATH         removes PATH
//   touch:PATH      writes PATH, empty

import { rmSync, writeFileSync } from "node:fs";
import {
  applyPayloadEnvironment,
  CheckpointStore,
  ExecHistoryStore,
  preparePayloadRuntime,
  type RuntimeId,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { CountingTransport } from "./session-fixture.ts";

if (import.meta.main) {
  const [payload, stateDir, ...steps] = process.argv.slice(2);
  if (!payload || !stateDir)
    throw new Error(
      "usage: bun payload-runtime-command.ts PAYLOAD STATE_DIR STEP...",
    );
  applyPayloadEnvironment(payload);
  const transport = new CountingTransport(false);
  const manager = new SessionManager(
    new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
    new SessionCatalogStore(stateDir),
    new ExecHistoryStore(stateDir),
    new CheckpointStore(stateDir),
    { maxSessions: 8, warnUsagePercent: 75, defaultCols: 80, defaultRows: 24 },
    () => undefined,
  );
  for (const step of steps) {
    const at = step.indexOf(":");
    const [kind, value] = [step.slice(0, at), step.slice(at + 1)];
    try {
      if (kind === "env") console.log(JSON.stringify(process.env[value]));
      else if (kind === "prepare") {
        preparePayloadRuntime(value as RuntimeId);
        console.log(JSON.stringify("ok"));
      } else if (kind === "create") {
        await manager.createWithPolicy(
          "actor_1",
          "payload",
          stateDir,
          { durabilityMode: "ephemeral" },
          "controller",
        );
        console.log(JSON.stringify({ starts: transport.startCount }));
      } else if (kind === "rm") {
        rmSync(value);
        console.log(JSON.stringify("ok"));
      } else if (kind === "touch") {
        writeFileSync(value, "");
        console.log(JSON.stringify("ok"));
      } else throw new Error(`unknown step ${step}`);
    } catch (error) {
      console.log(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          starts: transport.startCount,
        }),
      );
    }
  }
  await manager.shutdown();
}
