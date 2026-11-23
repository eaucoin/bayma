import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, type SessionCheckpoint } from "@bayma/core";
import {
  waitForSettledExec,
  McpStdioClient,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";
import type { RuntimeId } from "../../support/runtimes.ts";

// With --checkpoint-reuse on, a Python session reads its committed checkpoint
// only as an exec reads it, and a Bun or Python session whose exec left its
// checkpoint as committed, made as the runtime makes one now, commits none.
// What every exec reads and every commit holds are what they are with it off.

const TEST_TIMEOUT_MS = 180_000;
const EXEC_SETTLE_TIMEOUT_MS = 90_000;

/** A server on `stateDir`, sessions checkpointed, with --checkpoint-reuse `reuse`. */
function serve(stateDir: string, reuse: "on" | "off"): Promise<McpStdioClient> {
  return McpStdioClient.connect({
    stateDir,
    defaultDurability: "checkpointed",
    serverArgs: ["--checkpoint-reuse", reuse],
  });
}

async function createSession(
  client: McpStdioClient,
  runtime: RuntimeId,
  cwd: string,
): Promise<string> {
  const created = await client.callTool<{ session: { session_id: string } }>(
    "session.create",
    { runtime, title: `${runtime}-checkpoint-reuse`, cwd },
  );
  return created.session.session_id;
}

/** The result of `code`, run to its end in the session, which must succeed. */
async function run(
  client: McpStdioClient,
  sessionId: string,
  code: string,
): Promise<string> {
  const settled = await waitForSettledExec(
    client,
    sessionId,
    await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 1000,
    }),
    { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
  );
  expect(settled.error_text ?? "").toBe("");
  expect(settled.status).toBe("ok");
  return settled.result_text ?? "";
}

/** The session's committed checkpoint's manifest. */
function manifest(
  stateDir: string,
  sessionId: string,
): SessionCheckpoint | null {
  return new CheckpointStore(stateDir).inspect(sessionId).checkpoint;
}

/** The value the session's committed Python checkpoint holds, as pickle reads it, as JSON. */
function committedPython(stateDir: string, sessionId: string): string {
  const snapshot = new CheckpointStore(stateDir).snapshot(sessionId);
  const read = Bun.spawnSync([
    "python3",
    "-c",
    "import json, pickle, sys; print(json.dumps(pickle.load(open(sys.argv[1], 'rb')), sort_keys=True))",
    snapshot!.payloadAbsolutePath!,
  ]);
  expect(read.stderr.toString()).toBe("");
  return read.stdout.toString().trim();
}

/**
 * Runs `execs` in a new session of `runtime` under --checkpoint-reuse `reuse`,
 * the server started again before the last, and returns each exec's result
 * and, after each, the committed checkpoint's revision.
 */
async function script(
  runtime: RuntimeId,
  reuse: "on" | "off",
  execs: readonly string[],
  readCommitted = false,
): Promise<{
  results: string[];
  revisions: (string | undefined)[];
  committed: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "bayma-checkpoint-reuse-"));
  const stateDir = join(root, "state");
  let client: McpStdioClient | undefined;
  try {
    client = await serve(stateDir, reuse);
    const sessionId = await createSession(client, runtime, root);
    const results: string[] = [];
    const revisions: (string | undefined)[] = [];
    for (const [index, code] of execs.entries()) {
      if (index === execs.length - 1) {
        await client.close();
        client = await serve(stateDir, reuse);
        await client.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
      }
      results.push(await run(client, sessionId, code));
      revisions.push(manifest(stateDir, sessionId)?.revision);
    }
    return {
      results,
      revisions,
      committed: readCommitted ? committedPython(stateDir, sessionId) : "",
    };
  } finally {
    await client?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  "a Python session reads and commits the same checkpoints with --checkpoint-reuse on as off, whatever it does to what it wrote or read",
  async () => {
    const execs = [
      // What it wrote, changed in a later exec through its own name, as the
      // checkpoint is not.
      'd = {"n": 1}\nbayma_write_checkpoint(d)\n"wrote"',
      'd["x"] = 1\n"changed d"',
      "bayma_read_checkpoint()",
      // What it read, changed in the exec that read it, and in a later one.
      'r = bayma_read_checkpoint()\nr["y"] = 2\n"changed r"',
      'r["z"] = 3\n"changed r later"',
      "sorted(bayma_read_checkpoint())",
      // Written anew, then read in the exec after the server came back.
      'bayma_write_checkpoint({"n": 2, "items": [1, 2]})\n"wrote again"',
      "1 + 1",
      "bayma_read_checkpoint()",
    ];
    const off = await script("python", "off", execs, true);
    const on = await script("python", "on", execs, true);
    expect(on.results).toEqual(off.results);
    expect(on.committed).toEqual(off.committed);
    expect(off.results[2]).toBe("{'n': 1}");
    expect(off.results[5]).toBe("['n', 'y']");
    // With it on, an exec that read nothing commits nothing: the revision
    // moves only with the execs that wrote or changed the checkpoint.
    const moved = on.revisions.map((revision, index) =>
      index === 0 ? true : revision !== on.revisions[index - 1],
    );
    expect(moved).toEqual([
      true,
      false,
      false,
      true,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(
      off.revisions.every(
        (revision, index) =>
          index === 0 || revision !== off.revisions[index - 1],
      ),
    ).toBe(true);
  },
  TEST_TIMEOUT_MS,
);

// A Python module whose objects count how often pickle loads them, in the
// interpreter's builtins, which outlive every exec.
const COUNTED_MODULE = [
  "import builtins",
  "class Counted:",
  "    def __init__(self, value):",
  "        self.value = value",
  "    def __setstate__(self, state):",
  "        builtins.bayma_test_loads = getattr(builtins, 'bayma_test_loads', 0) + 1",
  "        self.__dict__.update(state)",
].join("\\n");

test(
  "a Python session with --checkpoint-reuse on reads its checkpoint in the execs that read it alone",
  async () => {
    const loads = "import builtins\ngetattr(builtins, 'bayma_test_loads', 0)";
    const { results } = await script("python", "on", [
      [
        `open("counted.py", "w").write("${COUNTED_MODULE}\\n")`,
        "from counted import Counted",
        "bayma_write_checkpoint(Counted(41))",
        '"seeded"',
      ].join("\n"),
      loads,
      "bayma_read_checkpoint().value",
      loads,
      loads,
      "bayma_read_checkpoint().value",
    ]);
    expect(results).toEqual(["'seeded'", "0", "41", "1", "1", "41"]);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a checkpoint left as committed is committed again where the runtime that made it differs from the one that runs now",
  async () => {
    for (const runtime of ["python", "bun"] as const) {
      const root = mkdtempSync(join(tmpdir(), "bayma-checkpoint-reuse-"));
      const stateDir = join(root, "state");
      let client: McpStdioClient | undefined;
      try {
        client = await serve(stateDir, "on");
        const sessionId = await createSession(client, runtime, root);
        await run(
          client,
          sessionId,
          runtime === "python"
            ? 'bayma_write_checkpoint({"n": 1})\n"seeded"'
            : '$checkpoint = { n: 1 }; "seeded"',
        );
        await run(client, sessionId, '"left"');
        const made = manifest(stateDir, sessionId)!;
        await client.close();
        // As an older runtime made it.
        const path = new CheckpointStore(stateDir).manifestPath(sessionId);
        const written = JSON.parse(
          readFileSync(path, "utf8"),
        ) as SessionCheckpoint;
        writeFileSync(
          path,
          JSON.stringify({
            ...written,
            compatibility: {
              ...written.compatibility,
              runtimeVersion: "0.0.1",
            },
          }),
        );
        client = await serve(stateDir, "on");
        await client.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        await run(client, sessionId, '"left again"');
        const now = manifest(stateDir, sessionId)!;
        expect(now.revision).not.toBe(made.revision);
        expect(now.compatibility).toEqual(made.compatibility);
        expect(now.sha256).toBe(made.sha256);
      } finally {
        await client?.close().catch(() => undefined);
        rmSync(root, { recursive: true, force: true });
      }
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a Bun session with --checkpoint-reuse on commits a checkpoint an exec changed however deep, and none an exec left unchanged",
  async () => {
    const { results, revisions } = await script("bun", "on", [
      '$checkpoint = { a: { b: 1 } }; "seeded"',
      "1 + 1",
      // Reached through what it held, not through $checkpoint.
      'globalThis.held ??= $checkpoint.a; "held"',
      'held.b = 2; "changed"',
      "1 + 1",
      "$checkpoint.a.b",
    ]);
    expect(results.at(-1)).toBe("2");
    const moved = revisions.map((revision, index) =>
      index === 0 ? true : revision !== revisions[index - 1],
    );
    expect(moved).toEqual([true, false, false, true, false, false]);
  },
  TEST_TIMEOUT_MS,
);
