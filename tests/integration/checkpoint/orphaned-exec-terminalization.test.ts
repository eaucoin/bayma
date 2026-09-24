import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sessionExecUri } from "@bayma/core";
import { goHostCommand } from "@bayma/runtime-go";
import { leanHostCommand } from "@bayma/runtime-lean";
import {
  launchMcpHttpServer,
  type McpHttpClient,
} from "../../support/mcp-http-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";
import { withTempDir } from "../../support/temp.ts";

interface RuntimeRestartScenario {
  runtimeId: RuntimeId;
  seedCode: string;
  hangCode: string;
  readCode: string;
}

const scenarios: RuntimeRestartScenario[] = [
  {
    runtimeId: "bun",
    seedCode: '$checkpoint = { answer: 41 }; "seeded"',
    hangCode: "await new Promise(() => {})",
    readCode: "$checkpoint.answer + 1",
  },
  {
    runtimeId: "python",
    seedCode: 'bayma_write_checkpoint({"answer": 41})\n"seeded"',
    hangCode: "import time\ntime.sleep(3600)",
    readCode: 'bayma_read_checkpoint()["answer"] + 1',
  },
  {
    runtimeId: "dotnet-script",
    seedCode:
      'bayma_write_checkpoint(new Dictionary<string, int> { ["answer"] = 41 });\n"seeded"',
    hangCode: "System.Threading.Thread.Sleep(3600000);",
    readCode:
      'var checkpoint = bayma_read_checkpoint<Dictionary<string, int>>();\ncheckpoint!["answer"] + 1',
  },
  {
    runtimeId: "rust",
    seedCode: [
      'let state: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::from([(String::from("answer"), 41_i64)]);',
      "bayma_rust_support::write_checkpoint(&mut bayma_checkpoint, &state).unwrap();",
      '"seeded"',
    ].join("\n"),
    hangCode: "loop { std::hint::spin_loop(); }",
    readCode: [
      "let state: std::collections::BTreeMap<String, i64> = bayma_rust_support::read_checkpoint(&bayma_checkpoint).unwrap().unwrap();",
      'state["answer"] + 1',
    ].join("\n"),
  },
  {
    runtimeId: "lean",
    seedCode: 'def answer := 41\n#eval "seeded"',
    hangCode: "#eval IO.sleep 3600000",
    readCode: "#eval answer + 1",
  },
  {
    runtimeId: "go",
    seedCode: 'bayma_write_checkpoint(map[string]int{"answer": 41})\n"seeded"',
    hangCode: 'import "time"\ntime.Sleep(time.Hour)',
    readCode: [
      "var state map[string]int",
      "bayma_read_checkpoint(&state)",
      'state["answer"] + 1',
    ].join("\n"),
  },
];

/** Hosts, as their transports start them, with a cell that never ends. */
const hangingHosts = [
  {
    runtimeId: "lean",
    command: (scratch: string) => leanHostCommand(process.cwd(), scratch),
    spec: (root: string) => ({
      schema_version: 1,
      event_prefix: "__BAYMA_WATCHDOG_TEST__",
      code: "#eval IO.sleep 3600000",
      durability_mode: "ephemeral",
      restore_path: null,
      checkpoint_output_path: join(root, "checkpoint.bin"),
    }),
  },
  {
    runtimeId: "go",
    command: goHostCommand,
    spec: () => ({
      schema_version: 1,
      event_prefix: "__BAYMA_WATCHDOG_TEST__",
      code: "for {\n}",
      durability_mode: "ephemeral",
      checkpoint_json: null,
    }),
  },
];

interface Snapshot {
  exec_id: string;
  status: string;
  done: boolean;
  next_seq: number;
  result_text: string;
}

async function waitForSettled(
  client: McpHttpClient,
  sessionId: string,
  first: Snapshot,
): Promise<Snapshot> {
  let current = first;
  let resultText = first.result_text;
  while (!current.done) {
    current = await client.callTool<Snapshot>("wait", {
      session_id: sessionId,
      exec_id: current.exec_id,
      from_seq: current.next_seq,
      yield_time_ms: 1_000,
    });
    resultText += current.result_text;
  }
  return { ...current, result_text: resultText };
}

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function forceStopOwnedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await waitForCondition(
    () => child.exitCode !== null || child.signalCode !== null,
    "owned host cleanup",
    10_000,
  );
}

test("Rust host exits when its protocol owner disappears during execution", async () => {
  // The payload supplies the host, so the native protocol is exercised with
  // exactly the binary and roots the transport spawns.
  const hostBinary = process.env.BAYMA_RUST_HOST_BIN;
  expect(hostBinary).toBeTruthy();
  await withTempDir(async (root) => {
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "cargo-home"), { recursive: true });
    const sourcePath = join(root, "cell.rs");
    const specPath = join(root, "exec.json");
    const code =
      'println!("watchdog-started"); loop { std::hint::spin_loop(); }';
    const eventPrefix = "__BAYMA_WATCHDOG_TEST__";
    writeFileSync(sourcePath, code + "\n", "utf8");
    writeFileSync(
      specPath,
      JSON.stringify({
        schema_version: 1,
        event_prefix: eventPrefix,
        exec_id: "exec_watchdog_test",
        code,
        source_path: sourcePath,
        durability_mode: "ephemeral",
        checkpoint_json: null,
        checkpoint_output_path: join(root, "checkpoint.json"),
      }),
      "utf8",
    );

    const child = spawn(hostBinary!, [], {
      cwd: process.cwd(),
      detached: true,
      env: {
        ...process.env,
        EVCXR_CONFIG_DIR: root,
        CARGO_HOME: join(root, "cargo-home"),
        BAYMA_RUST_CACHE_DIR: join(root, "cache"),
        BAYMA_RUST_OWNS_PROCESS_TREE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => {
      stdout += Buffer.from(chunk).toString("utf8");
    });
    child.stderr!.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
    });

    try {
      await waitForCondition(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Rust host exited before prompt; stderr=${stderr}`);
        }
        return stdout.includes("BAYMA> ");
      }, `Rust host prompt; stderr=${stderr}`);
      child.stdin!.write(`:exec ${specPath}\n`);
      await waitForCondition(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(
            `Rust host exited before execution started; stderr=${stderr}`,
          );
        }
        return (
          stdout.includes(eventPrefix) && stdout.includes("watchdog-started")
        );
      }, `Rust execution start; stderr=${stderr}`);

      child.stdin!.end();
      await waitForCondition(
        () => child.exitCode !== null || child.signalCode !== null,
        `Rust host exit after protocol EOF; stderr=${stderr}`,
        10_000,
      );
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      await forceStopOwnedProcess(child);
    }
  });
}, 180_000);

for (const host of hangingHosts) {
  test(`${host.runtimeId} host exits when its protocol owner disappears during execution`, async () => {
    await withTempDir(async (root) => {
      const command = host.command(join(root, "scratch"));
      const specPath = join(root, "exec.json");
      writeFileSync(specPath, JSON.stringify(host.spec(root)), "utf8");
      const child = spawn(command.file, command.args, {
        cwd: process.cwd(),
        detached: true,
        env: { ...process.env, ...command.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (chunk) => {
        stdout += Buffer.from(chunk).toString("utf8");
      });
      child.stderr!.on("data", (chunk) => {
        stderr += Buffer.from(chunk).toString("utf8");
      });
      try {
        await waitForCondition(() => {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`host exited before prompt; stderr=${stderr}`);
          }
          return stdout.includes("BAYMA> ");
        }, `host prompt; stderr=${stderr}`);
        child.stdin!.write(`:exec ${specPath}\n`);
        // The cell runs; nothing it does would end it.
        await sleep(2_000);
        expect(child.exitCode).toBeNull();
        child.stdin!.end();
        await waitForCondition(
          () => child.exitCode !== null || child.signalCode !== null,
          `host exit after protocol EOF; stderr=${stderr}`,
          10_000,
        );
      } finally {
        await forceStopOwnedProcess(child);
      }
    });
  }, 180_000);
}

for (const scenario of scenarios) {
  test(`abrupt ${scenario.runtimeId} restart terminalizes orphaned execs`, async () => {
    await withTempDir(async (root) => {
      const stateDir = join(root, "state");
      const first = await launchMcpHttpServer({
        stateDir,
        defaultDurability: "checkpointed",
      });
      const firstClient = await first.spawnClient();
      let second: Awaited<ReturnType<typeof launchMcpHttpServer>> | undefined;
      let secondClient: McpHttpClient | undefined;
      try {
        const created = await firstClient.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: scenario.runtimeId,
          title: `${scenario.runtimeId}-abrupt-restart`,
          cwd: process.cwd(),
        });
        const sessionId = created.session.session_id;
        const seeded = await waitForSettled(
          firstClient,
          sessionId,
          await firstClient.callTool<Snapshot>("exec", {
            session_id: sessionId,
            code: scenario.seedCode,
            yield_time_ms: 1_000,
          }),
        );
        expect(seeded.status).toBe("ok");

        const hanging = await firstClient.callTool<Snapshot>("exec", {
          session_id: sessionId,
          code: scenario.hangCode,
          yield_time_ms: 100,
        });
        expect(["queued", "running"]).toContain(hanging.status);
        expect(hanging.done).toBe(false);

        await first.stop();
        await firstClient.close().catch(() => undefined);

        second = await launchMcpHttpServer({
          stateDir,
          defaultDurability: "checkpointed",
        });
        secondClient = await second.spawnClient();
        const recovered = await secondClient.readJsonResource<{
          exec: {
            status: string;
            interruptionReason?: string;
            finishedAtMs?: number;
            durationMs?: number;
          };
        }>(sessionExecUri(sessionId, hanging.exec_id));
        expect(recovered.exec).toEqual(
          expect.objectContaining({
            status: "interrupted",
            interruptionReason: "server_restart",
            finishedAtMs: expect.any(Number),
            durationMs: expect.any(Number),
          }),
        );

        const waited = await secondClient.callTool<Snapshot>("wait", {
          session_id: sessionId,
          exec_id: hanging.exec_id,
          yield_time_ms: 1_000,
        });
        expect(waited.status).toBe("interrupted");
        expect(waited.done).toBe(true);

        await secondClient.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        const afterRestart = await waitForSettled(
          secondClient,
          sessionId,
          await secondClient.callTool<Snapshot>("exec", {
            session_id: sessionId,
            code: scenario.readCode,
            yield_time_ms: 1_000,
          }),
        );
        expect(afterRestart.status).toBe("ok");
        expect(afterRestart.result_text).toContain("42");
      } finally {
        await firstClient.close().catch(() => undefined);
        await secondClient?.close().catch(() => undefined);
        await first.close().catch(() => undefined);
        await second?.close().catch(() => undefined);
      }
    });
  }, 180_000);
}
