import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpStdioClient,
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";

// What Lean sessions do beyond the shared scenario corpus: the first cell's
// imports, messages that reach their channels by severity, recovery that
// brings back everything a session declared, and the Lean a project names.

const EXEC_SETTLE_TIMEOUT_MS = 90_000;

async function createSession(
  client: McpStdioClient,
  cwd = process.cwd(),
): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime: "lean", title: "lean-sessions", cwd },
  );
  return created.session.session_id;
}

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

test("imports belong in a session's first cell", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client);
    const first = await run(
      client,
      session,
      "import Lean.Data.Json\nopen Lean\n#eval (Json.mkObj []).compress",
    );
    expect(first.status).toBe("ok");
    expect(first.result_text).toBe('"{}"');
    const later = await run(client, session, "import Lean");
    expect(later.status).toBe("error");
    expect(later.error_text).toContain("must be used in the beginning");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);

test("a cell's messages reach its channels by severity, with their positions", async () => {
  await withMcpStdio(async (client) => {
    const session = await createSession(client);
    const warned = await run(
      client,
      session,
      "theorem t : 1 = 1 := sorry\n#check t",
    );
    expect(warned.status).toBe("ok");
    expect(warned.stderr_text).toContain(
      "1:8: warning: declaration uses `sorry`",
    );
    expect(warned.result_text).toBe("t : 1 = 1");
    const broken = await run(client, session, 'def x : Nat := "no"');
    expect(broken.status).toBe("error");
    expect(broken.error_text).toContain("1:15: Type mismatch");
    await client.callTool("session.close", { session_id: session });
  });
}, 240_000);

test("checkpointed recovery restores everything the session declared", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "bayma-lean-recovery-"));
  let seed: McpStdioClient | undefined;
  let recovery: McpStdioClient | undefined;
  try {
    seed = await McpStdioClient.connect({
      stateDir,
      defaultDurability: "checkpointed",
    });
    const session = await createSession(seed);
    for (const cell of [
      "structure Point where\n  x : Nat\n  y : Nat\ninstance : Inhabited Point := ⟨⟨7, 8⟩⟩",
      "def keep := 41\n@[simp] theorem keep_eq : keep = 41 := rfl",
      "namespace Geo\ndef origin : Point := ⟨0, 0⟩\nend Geo\nopen Geo",
      "private def secret := 5",
    ])
      expect((await run(seed, session, cell)).status).toBe("ok");
    await seed.close();

    recovery = await McpStdioClient.connect({
      stateDir,
      defaultDurability: "checkpointed",
    });
    await recovery.callTool("session.acquire_controller", {
      session_id: session,
    });
    for (const [cell, result] of [
      ["#eval (default : Point).x + origin.y + secret", "12"],
      ["example : keep + 1 = 42 := by simp\n#eval keep + 1", "42"],
    ] as const) {
      const recovered = await run(recovery, session, cell);
      expect(recovered.status).toBe("ok");
      expect(recovered.result_text).toBe(result);
    }
  } finally {
    await seed?.close().catch(() => undefined);
    await recovery?.close().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 240_000);

test("a Lake project must name the Lean the runtime runs", async () => {
  const project = mkdtempSync(join(tmpdir(), "bayma-lean-project-"));
  try {
    writeFileSync(join(project, "lakefile.toml"), 'name = "elsewhere"\n');
    writeFileSync(join(project, "lean-toolchain"), "leanprover/lean4:v4.0.0\n");
    await withMcpStdio(async (client) => {
      const refusal = await createSession(client, project)
        .then((session) => run(client, session, "#eval 1"))
        .then((exec) => exec.error_text ?? "")
        .catch((error: unknown) => String(error));
      expect(refusal).toContain("names leanprover/lean4:v4.0.0");
      expect(refusal).toContain(
        `this runtime runs Lean ${process.env.BAYMA_LEAN_VERSION}`,
      );
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 240_000);
