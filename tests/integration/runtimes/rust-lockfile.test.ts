import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCargoRegistryFixture,
  FIXTURE_CRATE,
  LOCKED_VERSION,
  NEWER_VERSION,
} from "../../support/cargo-registry-fixture.ts";
import {
  processEnvironment,
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";

const EXEC_SETTLE_TIMEOUT_MS = 180_000;

async function run(
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

async function createSession(
  client: McpStdioClient,
  title: string,
): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime: "rust", title, cwd: process.cwd() },
  );
  return created.session.session_id;
}

test(":lockfile resolves a session's dependencies against a Cargo.lock, yanked versions included", async () => {
  const root = mkdtempSync(join(tmpdir(), "bayma-rust-lockfile-"));
  try {
    const fixture = createCargoRegistryFixture(join(root, "registry"));
    const env = {
      ...processEnvironment(),
      // A private cache keeps the fixture registry out of the shared Cargo home.
      BAYMA_CACHE_DIR: join(root, "cache"),
      CARGO_REGISTRIES_FIXTURE_INDEX: fixture.indexUrl,
    };
    await withMcpStdio(
      async (client) => {
        const locked = await createSession(client, "rust-lockfile");
        const missing = await run(
          client,
          locked,
          `:lockfile ${join(root, "absent.lock")}`,
        );
        expect(missing.status).toBe("error");
        expect(missing.error_text).toContain("Failed to read lockfile");

        const chosen = await run(
          client,
          locked,
          `:lockfile ${fixture.lockfile}`,
        );
        expect(chosen.status).toBe("ok");
        expect(chosen.result_text).toContain(`Lockfile: ${fixture.lockfile}`);
        expect(
          (
            await run(
              client,
              locked,
              `:dep ${FIXTURE_CRATE} = ${fixture.dependency}`,
            )
          ).status,
        ).toBe("ok");
        const lockedVersion = await run(
          client,
          locked,
          `${FIXTURE_CRATE}::VERSION`,
        );
        expect(lockedVersion.status).toBe("ok");
        expect(lockedVersion.result_text).toContain(LOCKED_VERSION);

        const cleared = await run(client, locked, ":lockfile");
        expect(cleared.result_text).toContain("Lockfile: none");

        const unlocked = await createSession(client, "rust-no-lockfile");
        expect(
          (
            await run(
              client,
              unlocked,
              `:dep ${FIXTURE_CRATE} = ${fixture.dependency}`,
            )
          ).status,
        ).toBe("ok");
        const newestVersion = await run(
          client,
          unlocked,
          `${FIXTURE_CRATE}::VERSION`,
        );
        expect(newestVersion.status).toBe("ok");
        expect(newestVersion.result_text).toContain(NEWER_VERSION);

        for (const sessionId of [locked, unlocked]) {
          await client.callTool("session.close", { session_id: sessionId });
        }
      },
      { env },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 600_000);
