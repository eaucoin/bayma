import { expect, test } from "bun:test";
import {
  waitForSettledExec,
  withMcpStdio,
  type ExecSnapshot,
} from "../../support/mcp-stdio-client.ts";

const EXEC_SETTLE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;

// A runtime the server's runtime memory budget covers only as it is given
// one, as Bun is, is held to it as C# and Go are by default: past it, as a
// host that comes to hold 32 MiB more than it started with is past one of
// 1 MiB, it is started again from the session's checkpoint once an exec has
// ended, and the next exec told so, the notice saying nothing of what it
// keeps, as it keeps nothing of each cell.
test(
  "a Bun host past the runtime memory budget is started again from its checkpoint, the next exec told so",
  async () => {
    await withMcpStdio(
      async (client) => {
        const created = await client.callTool<{
          session: { session_id: string };
        }>("session.create", {
          runtime: "bun",
          title: "bun-memory-budget",
          cwd: process.cwd(),
        });
        const sessionId = created.session.session_id;
        const exec = async (code: string) =>
          waitForSettledExec(
            client,
            sessionId,
            await client.callTool<ExecSnapshot>("exec", {
              session_id: sessionId,
              code,
              yield_time_ms: 1_000,
            }),
            { timeoutMs: EXEC_SETTLE_TIMEOUT_MS },
          );
        const first = await exec(
          "$checkpoint = { answer: 41 }; globalThis.held = new Uint8Array(32 << 20).fill(1); process.pid",
        );
        expect(first.status).toBe("ok");
        expect(first.notice).toBeUndefined();
        const second = await exec("`${$checkpoint.answer + 1} ${process.pid}`");
        expect(second.status).toBe("ok");
        expect(second.notice ?? "").toMatch(
          /^bayma: this session's runtime came to hold \d+ MiB more than it held as it started, past the server's runtime memory budget of 1 MiB, so it was started again from its checkpoint: only its checkpointed state survived, and the rest of its live state is gone\.$/,
        );
        const [answer, pid] = (second.result_text ?? "")
          .replaceAll('"', "")
          .trim()
          .split(" ");
        expect(answer).toBe("42");
        expect(pid).not.toBe((first.result_text ?? "").trim());
      },
      {
        defaultDurability: "checkpointed",
        serverArgs: ["--runtime-memory-budget-mb", "bun=1"],
      },
    );
  },
  TEST_TIMEOUT_MS,
);

/** Runs `code` in the session, settled. */
async function settled(
  client: Parameters<Parameters<typeof withMcpStdio>[0]>[0],
  sessionId: string,
  code: string,
  timeoutMs = EXEC_SETTLE_TIMEOUT_MS,
): Promise<ExecSnapshot> {
  return waitForSettledExec(
    client,
    sessionId,
    await client.callTool<ExecSnapshot>("exec", {
      session_id: sessionId,
      code,
      yield_time_ms: 1_000,
    }),
    { timeoutMs },
  );
}

async function created(
  client: Parameters<Parameters<typeof withMcpStdio>[0]>[0],
  runtime: string,
): Promise<string> {
  const { session } = await client.callTool<{
    session: { session_id: string };
  }>("session.create", {
    runtime,
    title: `${runtime}-memory-budget`,
    cwd: process.cwd(),
  });
  return session.session_id;
}

// A Python host that comes to hold much, as one loading a model does, holds
// it as its user means it to: the budget covers C# and Go alone by default.
test(
  "a Python host that comes to hold far past the runtime memory budget is left as it is by default",
  async () => {
    await withMcpStdio(
      async (client) => {
        const sessionId = await created(client, "python");
        const first = await settled(
          client,
          sessionId,
          "import os\nheld = bytearray(64 << 20)\nos.getpid()",
        );
        expect(first.status).toBe("ok");
        const second = await settled(
          client,
          sessionId,
          "len(held), os.getpid()",
        );
        expect(second.notice).toBeUndefined();
        expect(second.result_text).toBe(
          `(${64 << 20}, ${(first.result_text ?? "").trim()})`,
        );
      },
      {
        defaultDurability: "checkpointed",
        serverArgs: ["--runtime-memory-budget-mb", "1"],
      },
    );
  },
  TEST_TIMEOUT_MS,
);

// A Rust host runs its cells in a child of its own, which the budget counts
// with it, as it does every process of the host's process group.
test("a Rust host whose evaluator child comes to hold past the runtime memory budget given it is started again from its checkpoint", async () => {
  await withMcpStdio(
    async (client) => {
      const sessionId = await created(client, "rust");
      const first = await settled(
        client,
        sessionId,
        "let held: &'static Vec<u8> = Box::leak(Box::new(vec![1u8; 64 << 20]));\nheld.len()",
        600_000,
      );
      expect(first.status).toBe("ok");
      const second = await settled(client, sessionId, "1 + 1", 600_000);
      expect(second.status).toBe("ok");
      expect(second.notice ?? "").toMatch(
        /^bayma: this session's runtime came to hold \d+ MiB more than it held as it started, past the server's runtime memory budget of 16 MiB, so it was started again from its checkpoint/,
      );
    },
    {
      defaultDurability: "checkpointed",
      serverArgs: ["--runtime-memory-budget-mb", "rust=16"],
    },
  );
}, 1_200_000);
