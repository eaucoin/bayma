import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { sessionUri, CheckpointStore } from "@bayma/core";
import {
  McpStdioClient,
  waitForSettledExec,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";
import { withEngine } from "../../support/engine-harness.ts";
import type { RuntimeId } from "../../support/runtimes.ts";

interface RuntimeScenario {
  runtimeId: RuntimeId;
  expectedCodecId: string;
  expectedPayloadKind: string;
  writeCounter(counter: number): string;
  writeCounterThenThrow(counter: number): string;
  readCounter(): string;
  writeLargePayload(): string;
  readLargePayload(): string;
  expectedLargeResult: string;
}

const EXEC_SETTLE_TIMEOUT_MS = 120_000;
const RUNTIME_STRESS_TIMEOUT_MS = 360_000;

const RUNTIME_SCENARIOS: RuntimeScenario[] = [
  {
    runtimeId: "bun",
    expectedCodecId: "bun-jsc-structured-clone-v1",
    expectedPayloadKind: "binary-sidecar",
    writeCounter: (counter) =>
      `$checkpoint = { answer: ${counter}, nested: { label: "cycle-${counter}" } }; "seed-${counter}"`,
    writeCounterThenThrow: (counter) =>
      `$checkpoint = { answer: ${counter} }; throw new Error("expected failure")`,
    readCounter: () => "$checkpoint.answer",
    writeLargePayload: () =>
      [
        "const bytes = new Uint8Array(Array.from({ length: 1024 }, (_, index) => index % 251));",
        "$checkpoint = {",
        "  title: 'large-bun',",
        "  bytes,",
        "  nested: new Map([['answer', 42]]),",
        "  items: new Set(Array.from({ length: 200 }, (_, index) => index)),",
        "};",
        "'large-seeded'",
      ].join("\n"),
    readLargePayload: () =>
      "$checkpoint.bytes.length + $checkpoint.nested.get('answer') + $checkpoint.items.size",
    expectedLargeResult: "1266",
  },
  {
    runtimeId: "python",
    expectedCodecId: "python-pickle-protocol5-v1",
    expectedPayloadKind: "binary-sidecar",
    writeCounter: (counter) =>
      `bayma_write_checkpoint({"answer": ${counter}, "nested": {"label": "cycle-${counter}"}})\n"seed-${counter}"`,
    writeCounterThenThrow: (counter) =>
      `bayma_write_checkpoint({"answer": ${counter}})\nraise RuntimeError("expected failure")`,
    readCounter: () => 'bayma_read_checkpoint()["answer"]',
    writeLargePayload: () =>
      [
        "bayma_write_checkpoint({",
        '    "title": "large-python",',
        '    "items": set(range(200)),',
        '    "nested": {"answer": 42},',
        '    "blob": bytes(range(250)) * 4,',
        "})",
        '"large-seeded"',
      ].join("\n"),
    readLargePayload: () =>
      'len(bayma_read_checkpoint()["items"]) + bayma_read_checkpoint()["nested"]["answer"] + len(bayma_read_checkpoint()["blob"])',
    expectedLargeResult: "1242",
  },
  {
    runtimeId: "dotnet-script",
    expectedCodecId: "dotnet-system-text-json-v2",
    expectedPayloadKind: "text-sidecar",
    writeCounter: (counter) =>
      `bayma_write_checkpoint(new Dictionary<string, int> { ["answer"] = ${counter} });\n"seed-${counter}"`,
    writeCounterThenThrow: (counter) =>
      `bayma_write_checkpoint(new Dictionary<string, int> { ["answer"] = ${counter} });\nthrow new Exception("expected failure");`,
    readCounter: () =>
      'var checkpoint = bayma_read_checkpoint<Dictionary<string, int>>();\ncheckpoint!["answer"]',
    writeLargePayload: () =>
      [
        'var payload = Enumerable.Range(0, 200).ToDictionary(index => "k" + index, index => index);',
        'payload["answer"] = 42;',
        "bayma_write_checkpoint(payload);",
        '"large-seeded"',
      ].join("\n"),
    readLargePayload: () =>
      'var checkpoint = bayma_read_checkpoint<Dictionary<string, int>>();\ncheckpoint!["answer"] + checkpoint.Count',
    expectedLargeResult: "243",
  },
  {
    runtimeId: "rust",
    expectedCodecId: "rust-serde-json-v1",
    expectedPayloadKind: "text-sidecar",
    writeCounter: (counter) =>
      [
        `let state: std::collections::BTreeMap<String, bayma_rust_support::serde_json::Value> = std::collections::BTreeMap::from([`,
        `    (String::from("answer"), bayma_rust_support::serde_json::json!(${counter})),`,
        `    (String::from("nested"), bayma_rust_support::serde_json::json!({"label": "cycle-${counter}"})),`,
        "]);",
        "bayma_rust_support::write_checkpoint(&mut bayma_checkpoint, &state).unwrap();",
        `"seed-${counter}"`,
      ].join("\n"),
    writeCounterThenThrow: (counter) =>
      [
        `let state: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::from([(String::from("answer"), ${counter}_i64)]);`,
        "bayma_rust_support::write_checkpoint(&mut bayma_checkpoint, &state).unwrap();",
        'panic!("expected failure");',
      ].join("\n"),
    readCounter: () =>
      [
        "let state: std::collections::BTreeMap<String, bayma_rust_support::serde_json::Value> = bayma_rust_support::read_checkpoint(&bayma_checkpoint).unwrap().unwrap();",
        'state["answer"].as_i64().unwrap()',
      ].join("\n"),
    writeLargePayload: () =>
      [
        'let payload: std::collections::BTreeMap<String, i64> = (0_i64..200_i64).map(|index| (format!("k{index}"), index)).collect();',
        "bayma_rust_support::write_checkpoint(&mut bayma_checkpoint, &payload).unwrap();",
        '"large-seeded"',
      ].join("\n"),
    readLargePayload: () =>
      [
        "let payload: std::collections::BTreeMap<String, i64> = bayma_rust_support::read_checkpoint(&bayma_checkpoint).unwrap().unwrap();",
        "payload.len() as i64 + payload.values().sum::<i64>()",
      ].join("\n"),
    expectedLargeResult: "20100",
  },
  {
    runtimeId: "go",
    expectedCodecId: "json-v1",
    expectedPayloadKind: "json-inline",
    writeCounter: (counter) =>
      `bayma_write_checkpoint(map[string]any{"answer": ${counter}, "nested": map[string]string{"label": "cycle-${counter}"}})\n"seed-${counter}"`,
    writeCounterThenThrow: (counter) =>
      `bayma_write_checkpoint(map[string]int{"answer": ${counter}})\npanic("expected failure")`,
    readCounter: () =>
      'var state map[string]int\nbayma_read_checkpoint(&state)\nstate["answer"]',
    writeLargePayload: () =>
      [
        'import "fmt"',
        "payload := map[string]int{}",
        "for index := 0; index < 200; index++ {",
        '\tpayload[fmt.Sprint("k", index)] = index',
        "}",
        "bayma_write_checkpoint(payload)",
        '"large-seeded"',
      ].join("\n"),
    readLargePayload: () =>
      [
        "var payload map[string]int",
        "bayma_read_checkpoint(&payload)",
        "total := len(payload)",
        "for _, value := range payload {",
        "\ttotal += value",
        "}",
        "total",
      ].join("\n"),
    expectedLargeResult: "20100",
  },
];

async function submitAndWait(
  client: McpStdioClient,
  sessionId: string,
  code: string,
): Promise<ExecSnapshot> {
  return waitForSettledExec(
    client,
    sessionId,
    await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 1_000,
    }),
    { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
  );
}

function readManifest(
  stateDir: string,
  sessionId: string,
): {
  codecId: string;
  payloadKind: string;
  payloadPath?: string;
  byteLength: number;
  sha256: string;
} {
  return JSON.parse(
    readFileSync(
      join(stateDir, "checkpoints", sessionId, "manifest.json"),
      "utf8",
    ),
  );
}

async function connectCheckpointed(stateDir: string): Promise<McpStdioClient> {
  return McpStdioClient.connect({
    stateDir,
    defaultDurability: "checkpointed",
  });
}

test.serial(
  "state mutations from settled errors survive restart across every runtime",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-error-checkpoint-"));
    try {
      for (const scenario of RUNTIME_SCENARIOS) {
        const stateDir = join(root, scenario.runtimeId, "state");
        const seedClient = await connectCheckpointed(stateDir);
        let sessionId = "";
        try {
          const created = await seedClient.callTool<{
            session: { session_id: string };
          }>("session.create", {
            runtime: scenario.runtimeId,
            title: `${scenario.runtimeId}-error-checkpoint`,
            cwd: process.cwd(),
          });
          sessionId = created.session.session_id;
          expect(
            (
              await submitAndWait(
                seedClient,
                sessionId,
                scenario.writeCounter(1),
              )
            ).status,
          ).toBe("ok");

          const failed = await submitAndWait(
            seedClient,
            sessionId,
            scenario.writeCounterThenThrow(42),
          );
          expect(failed.status).toBe("error");
          if (scenario.runtimeId === "rust") {
            expect(failed.error_text ?? "").toContain(
              "Rust execution panicked",
            );
            expect(failed.stderr_text ?? "").toContain("expected failure");
          } else {
            expect(failed.error_text ?? "").toContain("expected failure");
          }
        } finally {
          await seedClient.close();
        }

        const recoveryClient = await connectCheckpointed(stateDir);
        try {
          await recoveryClient.callTool("session.acquire_controller", {
            session_id: sessionId,
          });
          const recovered = await submitAndWait(
            recoveryClient,
            sessionId,
            scenario.readCounter(),
          );
          expect(recovered.status).toBe("ok");
          expect(recovered.result_text ?? "").toContain("42");
        } finally {
          await recoveryClient.close();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  RUNTIME_STRESS_TIMEOUT_MS,
);

/**
 * A cell that fails to compile, and what its error says, for the runtimes
 * that compile a cell before any of it runs.
 */
const COMPILE_FAILURES: {
  runtimeId: RuntimeId;
  code: string;
  error: string;
}[] = [
  {
    runtimeId: "rust",
    code: "let invalid_binding: = 42;",
    error: "expected type",
  },
  {
    runtimeId: "go",
    code: "undefined_name + 1",
    error: "undefined: undefined_name",
  },
];

for (const failure of COMPILE_FAILURES) {
  test.serial(
    `${failure.runtimeId} compilation failures preserve exact checkpoint authority`,
    async () => {
      const scenario = RUNTIME_SCENARIOS.find(
        (candidate) => candidate.runtimeId === failure.runtimeId,
      )!;
      const root = mkdtempSync(
        join(tmpdir(), `bayma-${failure.runtimeId}-compile-checkpoint-`),
      );
      const stateDir = join(root, "state");
      const client = await connectCheckpointed(stateDir);
      try {
        const created = await client.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: failure.runtimeId,
          title: `${failure.runtimeId}-compile-checkpoint-preservation`,
          cwd: process.cwd(),
        });
        const sessionId = created.session.session_id;
        expect(
          (await submitAndWait(client, sessionId, scenario.writeCounter(1)))
            .status,
        ).toBe("ok");
        const manifestPath = join(
          stateDir,
          "checkpoints",
          sessionId,
          "manifest.json",
        );
        const before = readFileSync(manifestPath, "utf8");

        const failed = await submitAndWait(client, sessionId, failure.code);
        expect(failed.status).toBe("error");
        expect(failed.error_text ?? "").toContain(failure.error);
        expect(readFileSync(manifestPath, "utf8")).toBe(before);

        const recovered = await submitAndWait(
          client,
          sessionId,
          scenario.readCounter(),
        );
        expect(recovered.status).toBe("ok");
        expect(recovered.result_text ?? "").toContain("1");
      } finally {
        await client.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    RUNTIME_STRESS_TIMEOUT_MS,
  );
}

test.serial(
  "repeated checkpointed restart recovery stays stable across every runtime",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-repeat-recovery-"));
    try {
      for (const scenario of RUNTIME_SCENARIOS) {
        const stateDir = join(root, scenario.runtimeId, "state");
        let sessionId: string | undefined;

        for (let cycle = 1; cycle <= 5; cycle += 1) {
          const client = await connectCheckpointed(stateDir);
          try {
            if (!sessionId) {
              const created = await client.callTool<{
                session: { session_id: string };
              }>("session.create", {
                runtime: scenario.runtimeId,
                title: `${scenario.runtimeId}-repeat-recovery`,
                cwd: process.cwd(),
              });
              sessionId = created.session.session_id;
            } else {
              await client.callTool("session.acquire_controller", {
                session_id: sessionId,
              });
              const recovered = await submitAndWait(
                client,
                sessionId,
                scenario.readCounter(),
              );
              expect(recovered.status).toBe("ok");
              expect(recovered.result_text ?? "").toContain(String(cycle - 1));
            }

            const seeded = await submitAndWait(
              client,
              sessionId,
              scenario.writeCounter(cycle),
            );
            expect(seeded.status).toBe("ok");
          } finally {
            await client.close();
          }
        }

        const finalClient = await connectCheckpointed(stateDir);
        try {
          await finalClient.callTool("session.acquire_controller", {
            session_id: sessionId,
          });
          const finalRecovered = await submitAndWait(
            finalClient,
            sessionId!,
            scenario.readCounter(),
          );
          expect(finalRecovered.status).toBe("ok");
          expect(finalRecovered.result_text ?? "").toContain("5");
        } finally {
          await finalClient.close();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  RUNTIME_STRESS_TIMEOUT_MS,
);

test.serial(
  "large checkpoint payloads recover with each runtime codec",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-large-checkpoints-"));
    try {
      for (const scenario of RUNTIME_SCENARIOS) {
        const stateDir = join(root, scenario.runtimeId, "state");
        const seedClient = await connectCheckpointed(stateDir);
        let sessionId = "";
        try {
          const created = await seedClient.callTool<{
            session: { session_id: string };
          }>("session.create", {
            runtime: scenario.runtimeId,
            title: `${scenario.runtimeId}-large-checkpoint`,
            cwd: process.cwd(),
          });
          sessionId = created.session.session_id;
          const seeded = await submitAndWait(
            seedClient,
            sessionId,
            scenario.writeLargePayload(),
          );
          expect(seeded.status).toBe("ok");
        } finally {
          await seedClient.close();
        }

        const manifest = readManifest(stateDir, sessionId);
        expect(manifest.codecId).toBe(scenario.expectedCodecId);
        expect(manifest.payloadKind).toBe(scenario.expectedPayloadKind);
        expect(manifest.byteLength).toBeGreaterThan(0);
        expect(manifest.sha256).toHaveLength(64);

        const recoveryClient = await connectCheckpointed(stateDir);
        try {
          await recoveryClient.callTool("session.acquire_controller", {
            session_id: sessionId,
          });
          const recovered = await submitAndWait(
            recoveryClient,
            sessionId,
            scenario.readLargePayload(),
          );
          expect(recovered.status).toBe("ok");
          expect(recovered.result_text ?? "").toContain(
            scenario.expectedLargeResult,
          );
        } finally {
          await recoveryClient.close();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  RUNTIME_STRESS_TIMEOUT_MS,
);

test.serial(
  "corrupted sidecar checkpoints quarantine instead of silently recovering",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-corrupt-checkpoint-"));
    try {
      const scenario = RUNTIME_SCENARIOS.find(
        (candidate) => candidate.runtimeId === "bun",
      )!;
      const stateDir = join(root, "state");
      const seedClient = await connectCheckpointed(stateDir);
      let sessionId = "";
      try {
        const created = await seedClient.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: "bun",
          title: "corrupt-bun-checkpoint",
          cwd: process.cwd(),
        });
        sessionId = created.session.session_id;
        const seeded = await submitAndWait(
          seedClient,
          sessionId,
          scenario.writeCounter(41),
        );
        expect(seeded.status).toBe("ok");
      } finally {
        await seedClient.close();
      }

      const manifest = readManifest(stateDir, sessionId);
      expect(manifest.payloadPath).toBeString();
      writeFileSync(
        join(stateDir, "checkpoints", sessionId, manifest.payloadPath!),
        Buffer.from("corrupted checkpoint payload"),
      );

      const recoveryClient = await connectCheckpointed(stateDir);
      try {
        await recoveryClient.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        let rejected = false;
        try {
          await recoveryClient.callTool("exec", {
            session_id: sessionId,
            code: scenario.readCounter(),
            yield_time_ms: 1_000,
          });
        } catch (error) {
          rejected = true;
          expect(String(error)).toContain("checkpoint");
        }
        expect(rejected).toBe(true);

        const session = await recoveryClient.readJsonResource<{
          session: { status: string; quarantineReason?: string };
        }>(sessionUri(sessionId));
        expect(session.session.status).toBe("quarantined");
        expect(session.session.quarantineReason ?? "").toContain("checkpoint");
      } finally {
        await recoveryClient.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  RUNTIME_STRESS_TIMEOUT_MS,
);

test.serial(
  "legacy inline dotnet checkpoints recover and migrate on the next commit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-dotnet-inline-migration-"));
    try {
      const scenario = RUNTIME_SCENARIOS.find(
        (candidate) => candidate.runtimeId === "dotnet-script",
      )!;
      const stateDir = join(root, "state");
      const seedClient = await connectCheckpointed(stateDir);
      let sessionId = "";
      try {
        const created = await seedClient.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: "dotnet-script",
          title: "dotnet-inline-migration",
          cwd: process.cwd(),
        });
        sessionId = created.session.session_id;
        const seeded = await submitAndWait(
          seedClient,
          sessionId,
          scenario.writeCounter(41),
        );
        expect(seeded.status).toBe("ok");
      } finally {
        await seedClient.close();
      }

      const store = new CheckpointStore(stateDir);
      const sidecar = store.snapshot(sessionId)!;
      const inlineJson = JSON.parse(
        readFileSync(sidecar.payloadAbsolutePath!, "utf8"),
      ) as unknown;
      store.write(sessionId, {
        ...sidecar.manifest,
        payloadKind: "json-inline",
        payloadPath: undefined,
        inlineJson,
      });
      expect(store.read(sessionId)?.payloadKind).toBe("json-inline");

      const recoveryClient = await connectCheckpointed(stateDir);
      try {
        await recoveryClient.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        const recovered = await submitAndWait(
          recoveryClient,
          sessionId,
          scenario.readCounter(),
        );
        expect(recovered.status).toBe("ok");
        expect(recovered.result_text ?? "").toContain("41");
      } finally {
        await recoveryClient.close();
      }

      expect(store.read(sessionId)?.payloadKind).toBe("text-sidecar");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  RUNTIME_STRESS_TIMEOUT_MS,
);

test.serial(
  "many checkpointed sessions recover random-access state after one restart",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-many-checkpoints-"));
    try {
      for (const scenario of RUNTIME_SCENARIOS) {
        const stateDir = join(root, scenario.runtimeId, "state");
        const sessionIds: string[] = [];
        const seedClient = await connectCheckpointed(stateDir);
        try {
          for (let index = 1; index <= 4; index += 1) {
            const created = await seedClient.callTool<{
              session: { session_id: string };
            }>("session.create", {
              runtime: scenario.runtimeId,
              title: `${scenario.runtimeId}-many-${index}`,
              cwd: process.cwd(),
            });
            sessionIds.push(created.session.session_id);
            const seeded = await submitAndWait(
              seedClient,
              created.session.session_id,
              scenario.writeCounter(index * 10),
            );
            expect(seeded.status).toBe("ok");
          }
        } finally {
          await seedClient.close();
        }

        const recoveryClient = await connectCheckpointed(stateDir);
        try {
          for (const [index, sessionId] of sessionIds.entries()) {
            await recoveryClient.callTool("session.acquire_controller", {
              session_id: sessionId,
            });
            const recovered = await submitAndWait(
              recoveryClient,
              sessionId,
              scenario.readCounter(),
            );
            expect(recovered.status).toBe("ok");
            expect(recovered.result_text ?? "").toContain(
              String((index + 1) * 10),
            );
          }
        } finally {
          await recoveryClient.close();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  RUNTIME_STRESS_TIMEOUT_MS,
);

test.serial(
  "interrupt recycle keeps recovering from the last committed Bun checkpoint",
  async () => {
    await withEngine(
      async ({ actor }) => {
        const { sessionId } = await actor.create("checkpoint-interrupt-stress");
        await actor.run(
          sessionId,
          "globalThis.keep = 10; globalThis.$checkpoint = { keep: globalThis.keep };",
          10_000,
        );

        for (let cycle = 0; cycle < 2; cycle += 1) {
          const hanging = await actor.submit(
            sessionId,
            "await new Promise(() => {})",
          );
          await sleep(50);
          await actor.interrupt(sessionId);
          await actor.waitForExec(sessionId, hanging.execId, 10_000);

          const exec = await actor.run(
            sessionId,
            "globalThis.keep += 1; globalThis.$checkpoint = { keep: globalThis.keep }; keep",
            10_000,
          );
          expect(exec.status).toBe("ok");
          expect(
            exec.messages.some(
              (message) =>
                message.kind === "result" &&
                message.text.includes(String(11 + cycle)),
            ),
          ).toBe(true);
        }
      },
      {
        resolveCreatePolicy: () => ({
          durabilityMode: "checkpointed",
          bootstrapCode: "globalThis.keep = globalThis.$checkpoint?.keep ?? 0;",
        }),
      },
    );
  },
  60_000,
);

test.serial(
  "runtime codec boundaries are explicit and recoverable",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-codec-boundaries-"));
    try {
      for (const scenario of RUNTIME_SCENARIOS.filter(
        (candidate) => candidate.runtimeId !== "dotnet-script",
      )) {
        const stateDir = join(root, scenario.runtimeId, "state");
        const client = await connectCheckpointed(stateDir);
        let sessionId = "";
        try {
          const created = await client.callTool<{
            session: { session_id: string };
          }>("session.create", {
            runtime: scenario.runtimeId,
            title: `${scenario.runtimeId}-codec-boundary`,
            cwd: process.cwd(),
          });
          sessionId = created.session.session_id;
          const seeded = await submitAndWait(
            client,
            sessionId,
            scenario.writeLargePayload(),
          );
          expect(seeded.status).toBe("ok");
        } finally {
          await client.close();
        }
        const manifest = readManifest(stateDir, sessionId);
        expect(manifest.codecId).toBe(scenario.expectedCodecId);
        expect(manifest.payloadKind).toBe(scenario.expectedPayloadKind);
      }

      const stateDir = join(root, "dotnet-script", "state");
      const dotnet = await connectCheckpointed(stateDir);
      let sessionId = "";
      try {
        const created = await dotnet.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: "dotnet-script",
          title: "dotnet-json-boundary",
          cwd: process.cwd(),
        });
        sessionId = created.session.session_id;
        const circular = await submitAndWait(
          dotnet,
          sessionId,
          [
            "var payload = new Dictionary<string, object?>();",
            'payload["self"] = payload;',
            "bayma_write_checkpoint(payload);",
            '"should-not-succeed"',
          ].join("\n"),
        );
        expect(circular.status).toBe("error");
        expect(circular.error_text ?? "").toContain("cycle");

        const valid = await submitAndWait(
          dotnet,
          sessionId,
          'bayma_write_checkpoint(new Dictionary<string, int> { ["answer"] = 41 });\n"valid"',
        );
        expect(valid.status).toBe("ok");
      } finally {
        await dotnet.close();
      }

      const recovery = await connectCheckpointed(stateDir);
      try {
        await recovery.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        const recovered = await submitAndWait(
          recovery,
          sessionId,
          'var checkpoint = bayma_read_checkpoint<Dictionary<string, int>>();\ncheckpoint!["answer"] + 1',
        );
        expect(recovered.status).toBe("ok");
        expect(recovered.result_text ?? "").toContain("42");
      } finally {
        await recovery.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  RUNTIME_STRESS_TIMEOUT_MS,
);
