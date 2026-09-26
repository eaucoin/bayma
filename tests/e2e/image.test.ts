import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctorSuccessOutput, RUNTIME_IDS, type RuntimeId } from "@bayma/core";
import {
  McpStdioClient,
  waitForSettledExec,
  type ExecSnapshot,
} from "../support/mcp-stdio-client.ts";
import { expectExactMcpSurface } from "../support/mcp-surface.ts";

// bayma as its users run it: the image `bun run image` builds, started with
// `docker run` as the README says, as the invoking user with a home mounted at
// its own path. Every server is a fresh container, so a REPL session that
// keeps its live state across two of them was restored from its process
// snapshot, not rebuilt from its checkpoint.

const repoRoot = resolve(import.meta.dir, "..", "..");
const version = JSON.parse(
  readFileSync(join(repoRoot, "packages", "server", "package.json"), "utf8"),
).version as string;
const IMAGE = `bayma:${version}`;
const IMAGE_TIMEOUT_MS = 1_800_000;

// What lets bayma snapshot REPL sessions within its own container.
const SNAPSHOT_FLAGS = [
  "--cap-add",
  "CHECKPOINT_RESTORE",
  "--cap-add",
  "SYS_PTRACE",
  "--security-opt",
  "seccomp=unconfined",
];

/** A home for one test, mounted at its own path, as the README mounts $HOME. */
function makeHome(): { home: string; stateDir: string } {
  const home = mkdtempSync(join(tmpdir(), "bayma-image-"));
  const stateDir = join(home, ".local", "state", "bayma", "test");
  mkdirSync(stateDir, { recursive: true });
  return { home, stateDir };
}

function userFlags(home: string): string[] {
  return [
    "--user",
    `${process.getuid!()}:${process.getgid!()}`,
    "-e",
    `HOME=${home}`,
    "-v",
    `${home}:${home}`,
    "-w",
    home,
  ];
}

async function run(
  command: string[],
): Promise<{ exitCode: number; stdout: string; output: string }> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, output: stdout + stderr };
}

/**
 * Serve MCP from a fresh container. Closing the client ends the server,
 * which snapshots its idle REPL sessions on the way out; `stop` waits for
 * the container to be gone, as the next server would have to.
 */
async function serve(
  home: string,
  stateDir: string,
): Promise<{ client: McpStdioClient; stop: () => Promise<void> }> {
  const name = `bayma-e2e-${process.pid}-${Date.now()}`;
  const client = await McpStdioClient.launch(
    {
      command: "docker",
      args: [
        "run",
        "-i",
        "--rm",
        "--name",
        name,
        ...userFlags(home),
        ...SNAPSHOT_FLAGS,
        IMAGE,
      ],
      binaryLabel: "bayma image",
    },
    { stateDir, defaultDurability: "checkpointed" },
  );
  return {
    client,
    async stop() {
      await client.close();
      // Gone already, or gone once it has finished shutting down.
      await run(["docker", "wait", name]);
    },
  };
}

async function execSettled(
  client: McpStdioClient,
  sessionId: string,
  code: string,
): Promise<ExecSnapshot> {
  const submitted = await client.callTool<ExecSnapshot>("exec", {
    session_id: sessionId,
    code,
    yield_time_ms: 1_000,
  });
  return waitForSettledExec(client, sessionId, submitted, {
    timeoutMs: 240_000,
  });
}

/** Code that leaves 41 in a live variable, and code that reads it plus one. */
const LIVE_STATE: Record<RuntimeId, { define: string; read: string }> = {
  bun: { define: "const marker = 41", read: "marker + 1" },
  python: { define: "marker = 41", read: "marker + 1" },
  "dotnet-script": { define: "var marker = 41;", read: "marker + 1" },
  rust: { define: "let marker = 41;", read: "marker + 1" },
  c: { define: "int marker = 41;", read: "marker + 1" },
  cpp: { define: "int marker = 41;", read: "marker + 1" },
  // Lean's sessions are never snapshotted; their checkpoints restore every
  // declaration, so the marker comes back all the same.
  lean: { define: "def marker := 41", read: "#eval marker + 1" },
  go: { define: "var marker = 41", read: "marker + 1" },
};

test.serial(
  "the image's doctor passes every runtime",
  async () => {
    const { home } = makeHome();
    try {
      const doctor = await run([
        "docker",
        "run",
        "--rm",
        ...userFlags(home),
        IMAGE,
        "doctor",
        "--format",
        "json",
      ]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toBe(doctorSuccessOutput(RUNTIME_IDS) + "\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  IMAGE_TIMEOUT_MS,
);

test.serial(
  "REPL sessions in every runtime keep their live state across servers in fresh containers, again and again",
  async () => {
    const { home, stateDir } = makeHome();
    try {
      const sessions = new Map<RuntimeId, string>();
      // What the servers so far said, for a failure's message.
      let servers = "";
      const first = await serve(home, stateDir);
      try {
        expectExactMcpSurface({
          tools: await first.client.listTools(),
          resourceTemplates: await first.client.listResourceTemplates(),
          resources: await first.client.listResources(),
        });
        for (const runtimeId of RUNTIME_IDS) {
          const created = await first.client.callTool<{
            session: { session_id: string };
          }>("session.create", {
            runtime: runtimeId,
            title: `image-${runtimeId}`,
            cwd: home,
          });
          sessions.set(runtimeId, created.session.session_id);
          const defined = await execSettled(
            first.client,
            created.session.session_id,
            LIVE_STATE[runtimeId].define,
          );
          expect(defined.status).toBe("ok");
        }
      } finally {
        await first.stop();
        servers = first.client.serverOutput();
      }

      // The second server restores what the first dumped, and the third what
      // the second dumped of what it restored.
      for (const last of [false, true]) {
        const next = await serve(home, stateDir);
        try {
          for (const runtimeId of RUNTIME_IDS) {
            const sessionId = sessions.get(runtimeId)!;
            await next.client.callTool("session.acquire_controller", {
              session_id: sessionId,
            });
            const read = await execSettled(
              next.client,
              sessionId,
              LIVE_STATE[runtimeId].read,
            );
            expect({
              runtimeId,
              status: read.status,
              result: read.result_text?.trim(),
              error: read.error_text || undefined,
              servers:
                read.status === "ok"
                  ? undefined
                  : servers + next.client.serverOutput(),
            }).toEqual({
              runtimeId,
              status: "ok",
              result: "42",
              error: undefined,
              servers: undefined,
            });
            if (last)
              await next.client.callTool("session.close", {
                session_id: sessionId,
              });
          }
        } finally {
          await next.stop();
          servers += next.client.serverOutput();
        }
      }
      // Restored snapshots are deleted, and closed sessions leave nothing.
      expect(readdirSync(join(stateDir, "snapshots"))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  IMAGE_TIMEOUT_MS,
);

test.serial(
  "a REPL session snapshotted before a reboot comes back from its checkpoint",
  async () => {
    const { home, stateDir } = makeHome();
    try {
      let sessionId: string;
      const first = await serve(home, stateDir);
      try {
        const created = await first.client.callTool<{
          session: { session_id: string };
        }>("session.create", { runtime: "python", title: "reboot", cwd: home });
        sessionId = created.session.session_id;
        const defined = await execSettled(
          first.client,
          sessionId,
          'marker = 41\nbayma_write_checkpoint({"marker": 41})',
        );
        expect(defined.status).toBe("ok");
      } finally {
        await first.stop();
      }

      // As if the machine had restarted since the snapshot was taken.
      const catalogPath = join(stateDir, "sessions", `${sessionId}.json`);
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(catalog.status).toBe("suspended");
      catalog.processSnapshot.bootId = "00000000-0000-0000-0000-000000000000";
      writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

      const second = await serve(home, stateDir);
      try {
        await second.client.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        const read = await execSettled(
          second.client,
          sessionId,
          '("marker" in globals(), bayma_read_checkpoint()["marker"] + 1)',
        );
        expect(read.status).toBe("ok");
        expect(read.result_text?.trim()).toBe("(False, 42)");
        await second.client.callTool("session.close", {
          session_id: sessionId,
        });
      } finally {
        await second.stop();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  IMAGE_TIMEOUT_MS,
);
