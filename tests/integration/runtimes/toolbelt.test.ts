import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLBELT_DIR } from "@bayma/core";
import {
  processEnvironment,
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
  type McpStdioClient,
} from "../../support/mcp-stdio-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";

// The toolbelt the payload carries, loaded in real sessions the way the
// bayma-toolbelt skill's quickstarts load it.

const EXEC_SETTLE_TIMEOUT_MS = 300_000;
const toolbelt = join(process.env.BAYMA_PAYLOAD_DIR!, TOOLBELT_DIR);

async function createSession(
  client: McpStdioClient,
  runtime: RuntimeId,
): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime, title: `toolbelt-${runtime}`, cwd: process.cwd() },
  );
  return created.session.session_id;
}

async function run(
  client: McpStdioClient,
  sessionId: string,
  code: string,
): Promise<ExecSnapshot> {
  const exec = await waitForSettledExec(
    client,
    sessionId,
    await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 1_000,
    }),
    { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
  );
  expect(exec.error_text).toBe("");
  expect(exec.status).toBe("ok");
  return exec;
}

test("Bun and Python sessions load the payload's toolbelt and use its packages", async () => {
  await withMcpStdio(async (client) => {
    const bun = await createSession(client, "bun");
    const opened = await run(
      client,
      bun,
      [
        `const { toolbelt } = await (await import(${JSON.stringify(join(toolbelt, "toolbelt.ts"))})).openToolbelt()`,
        "const tree = toolbelt.astGrep.napi.parse('python', 'def greet(): pass\\n')",
        "const counts = { packages: Object.keys(toolbelt).length, functions: tree.root().findAll({ rule: { kind: 'function_definition' } }).length }",
        "counts",
      ].join("\n"),
    );
    expect(opened.result_text).toContain("packages: 20");
    expect(opened.result_text).toContain("functions: 1");

    const python = await createSession(client, "python");
    const tested = await run(
      client,
      python,
      [
        "import sys, tempfile",
        "from pathlib import Path",
        `sys.path.insert(0, ${JSON.stringify(toolbelt)})`,
        "from bayma_toolbelt import open_toolbelt",
        "toolbelt = open_toolbelt()['toolbelt']",
        "directory = Path(tempfile.mkdtemp())",
        "(directory / 'test_probe.py').write_text('def test_probe():\\n    assert True\\n')",
        "result = toolbelt.run_pytest(directory, extra_args=('-q', '-p', 'no:cacheprovider'), cwd=directory)",
        "print(len(toolbelt.versions), result.stdout.strip().splitlines()[-1])",
      ].join("\n"),
    );
    expect(tested.stdout_text).toContain("23 1 passed");

    for (const sessionId of [bun, python])
      await client.callTool("session.close", { session_id: sessionId });
  });
}, 600_000);

test("a Rust session resolves the toolbelt's locked crates from the payload with no network", async () => {
  const cache = mkdtempSync(join(tmpdir(), "bayma-toolbelt-rust-"));
  try {
    await withMcpStdio(
      async (client) => {
        const rust = await createSession(client, "rust");
        await run(client, rust, `:lockfile ${join(toolbelt, "Cargo.lock")}`);
        await run(client, rust, ':dep lru = "=0.18.1"');
        const built = await run(
          client,
          rust,
          "lru::LruCache::<u8, u8>::unbounded().len()",
        );
        expect(built.result_text).toContain("0");
        await client.callTool("session.close", { session_id: rust });
      },
      {
        env: {
          ...processEnvironment(),
          // A fresh Cargo home, seeded only by the payload, and no network.
          BAYMA_CACHE_DIR: cache,
          CARGO_NET_OFFLINE: "true",
        },
      },
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}, 600_000);
