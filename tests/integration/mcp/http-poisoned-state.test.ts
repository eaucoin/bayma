import { expect, test } from "bun:test";
import {
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
  sessionExecUri,
  sessionUri,
} from "@bayma/core";
import { launchMcpHttpServer } from "../../support/mcp-http-client.ts";
import { withTempDir } from "../../support/temp.ts";

const poisonedStateHttpStartupBudgetMs = 5_000;
const poisonedStateHttpTestTimeoutMs = 10_000;

test(
  "mcp-http boots with poisoned persisted state without blocking",
  async () => {
    await withTempDir(async (dir) => {
      const catalogStore = new SessionCatalogStore(dir);
      const historyStore = new ExecHistoryStore(dir);
      const checkpointStore = new CheckpointStore(dir);

      catalogStore.write({
        sessionId: "sess_recoverable",
        runtimeId: "bun",
        title: "recoverable",
        cwd: process.cwd(),
        status: "live_busy",
        durabilityMode: "checkpointed",
        bootstrapCode:
          "globalThis.answer = globalThis.$checkpoint?.answer ?? 0;",
        checkpointRevision: "ckpt_good",
        checkpointUpdatedAtMs: 2,
        runtimeGeneration: 5,
        createdAtMs: 1,
        updatedAtMs: 2,
        closed: false,
        cols: 80,
        rows: 24,
      });
      historyStore.write("sess_recoverable", [
        {
          execId: "exec_poison",
          code: "await new Promise(() => {})",
          status: "running",
          submittedAtMs: 1,
          startedAtMs: 1,
          messages: [],
        },
      ]);
      checkpointStore.write("sess_recoverable", {
        revision: "ckpt_good",
        updatedAtMs: 2,
        value: { answer: 41 },
      });

      catalogStore.write({
        sessionId: "sess_quarantined",
        runtimeId: "bun",
        title: "quarantined",
        cwd: process.cwd(),
        status: "live_idle",
        durabilityMode: "checkpointed",
        checkpointRevision: "ckpt_missing",
        checkpointUpdatedAtMs: 2,
        runtimeGeneration: 3,
        createdAtMs: 1,
        updatedAtMs: 2,
        closed: false,
        cols: 80,
        rows: 24,
      });
      historyStore.write("sess_quarantined", [
        {
          execId: "exec_old",
          code: "42",
          status: "queued",
          submittedAtMs: 1,
          messages: [],
        },
      ]);

      const startedAtMs = Date.now();
      const server = await launchMcpHttpServer({ stateDir: dir });
      const client = await server.spawnClient();
      try {
        expect(Date.now() - startedAtMs).toBeLessThan(
          poisonedStateHttpStartupBudgetMs,
        );

        const sessions = await client.readJsonResource<{
          sessions: Array<{
            sessionId: string;
            status: string;
            historyLength: number;
          }>;
        }>("bayma:///sessions");
        expect(sessions.sessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionId: "sess_recoverable",
              status: "suspended",
              historyLength: 1,
            }),
            expect.objectContaining({
              sessionId: "sess_quarantined",
              status: "quarantined",
              historyLength: 1,
            }),
          ]),
        );

        const quarantined = await client.readJsonResource<{
          session: { status: string };
        }>(sessionUri("sess_quarantined"));
        expect(quarantined.session.status).toBe("quarantined");

        const recoveredExec = await client.readJsonResource<{
          exec: {
            status: string;
            interruptionReason?: string;
            finishedAtMs?: number;
          };
        }>(sessionExecUri("sess_recoverable", "exec_poison"));
        expect(recoveredExec.exec).toEqual(
          expect.objectContaining({
            status: "interrupted",
            interruptionReason: "server_restart",
            finishedAtMs: expect.any(Number),
          }),
        );
        const recoveredWait = await client.callTool<{
          status: string;
          done: boolean;
          changed: boolean;
        }>("wait", {
          session_id: "sess_recoverable",
          exec_id: "exec_poison",
          yield_time_ms: 1_000,
        });
        expect(recoveredWait).toEqual(
          expect.objectContaining({
            status: "interrupted",
            done: true,
            changed: false,
          }),
        );

        const quarantinedExec = await client.readJsonResource<{
          exec: { status: string; interruptionReason?: string };
        }>(sessionExecUri("sess_quarantined", "exec_old"));
        expect(quarantinedExec.exec).toEqual(
          expect.objectContaining({
            status: "interrupted",
            interruptionReason: "server_restart",
          }),
        );

        await client.callTool("session.acquire_controller", {
          session_id: "sess_recoverable",
        });
        const snapshot = await client.callTool<{
          status: string;
          done: boolean;
          result_text: string;
        }>("exec", {
          session_id: "sess_recoverable",
          code: "answer + 1",
          yield_time_ms: 1_000,
        });
        expect(snapshot.done).toBe(true);
        expect(snapshot.status).toBe("ok");
        expect(snapshot.result_text).toBe("42");

        const detail = await client.readJsonResource<{
          session: { status: string };
        }>(sessionUri("sess_recoverable"));
        expect(detail.session.status).toBe("live_idle");
      } finally {
        await client.close();
        await server.close();
      }
    });
  },
  { timeout: poisonedStateHttpTestTimeoutMs },
);
