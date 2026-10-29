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
import {
  DOCTOR_RESULT_SCHEMA_VERSION,
  doctorSuccessOutput,
  RUNTIME_IDS,
  type RuntimeId,
} from "@bayma/core";
import {
  McpStdioClient,
  waitForSettledExec,
  type ExecSnapshot,
} from "../support/mcp-stdio-client.ts";
import { expectExactMcpSurface } from "../support/mcp-surface.ts";

// bayma as its users run it: the image `bun run image` builds, started with
// `docker run` as the bayma command starts it, as the invoking user with a
// home mounted at its own path. Every server is a fresh container, so a REPL session that
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

/** A home for one test, mounted at its own path, as the bayma command mounts $HOME. */
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
 * What the image's entrypoint runs, from `docker run`'s arguments on, with
 * the container's PID counter moved first so that its first process takes
 * `pid`, as if the container had started that many before; set at once as
 * root, `settingCounter`, the server then run as the invoking user, where
 * the counter is far ahead.
 */
async function entrypointFrom(
  pid: number,
  settingCounter = false,
): Promise<string[]> {
  const inspected = await run([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{json .Config.Entrypoint}}",
    IMAGE,
  ]);
  expect(inspected.exitCode).toBe(0);
  const entrypoint = JSON.parse(inspected.stdout) as string[];
  const asUser = settingCounter
    ? [
        "setpriv",
        `--reuid=${process.getuid!()}`,
        `--regid=${process.getgid!()}`,
        "--clear-groups",
      ]
    : [];
  return [
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    'bayma-advance-pids "$0" && exec "$@"',
    String(pid - 1),
    ...asUser,
    ...entrypoint,
  ];
}

// What lets the PID helper set the counter at once, as root in a container
// whose /proc/sys is writable, and which no AppArmor profile keeps from
// writing it, as Docker's own does, rather than climb to it.
const COUNTER_SETTING_FLAGS = [
  "--user",
  "0:0",
  "--security-opt",
  "systempaths=unconfined",
  "--security-opt",
  "apparmor=unconfined",
];

/**
 * Serve MCP from a fresh container, its server's first process at
 * `firstPid` if given, `docker run` given `docker` besides. Closing the
 * client ends the server, which snapshots its idle REPL sessions on the way
 * out; `stop` waits for the container to be gone, as the next server would
 * have to.
 */
async function serve(
  home: string,
  stateDir: string,
  {
    firstPid,
    settingCounter = false,
    docker = [],
  }: { firstPid?: number; settingCounter?: boolean; docker?: string[] } = {},
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
        ...(settingCounter ? COUNTER_SETTING_FLAGS : []),
        ...docker,
        ...(firstPid === undefined
          ? [IMAGE]
          : await entrypointFrom(firstPid, settingCounter)),
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
      // Without the options that let CRIU run, doctor names them.
      expect(JSON.parse(doctor.stdout)).toEqual({
        schemaVersion: DOCTOR_RESULT_SCHEMA_VERSION,
        status: "passed",
        runtimes: RUNTIME_IDS,
        processSnapshots: {
          available: false,
          reason: expect.stringMatching(
            /CRIU could not start \(.*EPERM\): .*; run bayma's container with --cap-add CHECKPOINT_RESTORE --cap-add SYS_PTRACE --security-opt seccomp=unconfined$/,
          ),
        },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  IMAGE_TIMEOUT_MS,
);

test.serial(
  "the image's doctor finds that REPL sessions can be snapshotted, run as the README says",
  async () => {
    const { home } = makeHome();
    try {
      const doctor = await run([
        "docker",
        "run",
        "--rm",
        ...userFlags(home),
        ...SNAPSHOT_FLAGS,
        IMAGE,
        "doctor",
        "--runtime",
        "bun",
        "--format",
        "json",
      ]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toBe(
        doctorSuccessOutput(["bun"], undefined) + "\n",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  IMAGE_TIMEOUT_MS,
);

test.serial(
  "what the image's REPL sessions run writes no core file as it crashes, as on an Ubuntu host, unless it raises its limit, under tini as the container's first process",
  async () => {
    const { home, stateDir } = makeHome();
    try {
      // The hard limit the container is given, which the image leaves as is.
      const container = await run([
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        "ulimit -H -c",
      ]);
      expect(container.exitCode).toBe(0);
      const server = await serve(home, stateDir);
      try {
        const created = await server.client.callTool<{
          session: { session_id: string };
        }>("session.create", { runtime: "python", title: "core", cwd: home });
        const sessionId = created.session.session_id;
        const limits = await execSettled(
          server.client,
          sessionId,
          [
            "import resource",
            "soft, hard = resource.getrlimit(resource.RLIMIT_CORE)",
            "resource.setrlimit(resource.RLIMIT_CORE, (hard, hard))",
            "raised = resource.getrlimit(resource.RLIMIT_CORE)[0] == hard",
            'first = open("/proc/1/cmdline").read().split("\\0")[0]',
            '(soft, "unlimited" if hard == resource.RLIM_INFINITY else str(hard), raised, first)',
          ].join("\n"),
        );
        expect({
          status: limits.status,
          result: limits.result_text?.trim(),
        }).toEqual({
          status: "ok",
          result: `(0, '${container.stdout.trim()}', True, 'tini')`,
        });
        await server.client.callTool("session.close", {
          session_id: sessionId,
        });
      } finally {
        await server.stop();
      }
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

// As many processes as a container might start before its server.
const CONTAINER_START_PIDS = 1_000;

test.serial(
  "a REPL session comes back whole to a server whose own threads start where the session's tree would lie, had its server started it low",
  async () => {
    const { home, stateDir } = makeHome();
    try {
      let sessionId: string;
      const first = await serve(home, stateDir);
      try {
        const created = await first.client.callTool<{
          session: { session_id: string };
        }>("session.create", { runtime: "python", title: "pids", cwd: home });
        sessionId = created.session.session_id;
        // A thread of its own, so that the tree spans more than one ID.
        const defined = await execSettled(
          first.client,
          sessionId,
          "import threading\nthreading.Thread(target=threading.Event().wait, daemon=True).start()\nmarker = 41",
        );
        expect(defined.status).toBe("ok");
      } finally {
        await first.stop();
      }
      const { pid } = JSON.parse(
        readFileSync(join(stateDir, "sessions", `${sessionId}.json`), "utf8"),
      ).processSnapshot;

      // The next server starts at the tree's root, so far as a container's
      // first processes reach: its own threads, which start before it can
      // reserve any PID, take those a tree started that low needs.
      const second = await serve(home, stateDir, {
        firstPid: Math.min(pid, CONTAINER_START_PIDS),
      });
      try {
        await second.client.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        const read = await execSettled(second.client, sessionId, "marker + 1");
        expect({
          status: read.status,
          result: read.result_text?.trim(),
          error: read.error_text || undefined,
        }).toEqual({ status: "ok", result: "42", error: undefined });
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

// A tree's highest PID after a container's PIDs have climbed for days, as the
// folder server's did, past which the server before this fix moved its PID
// counter a process a PID, some 250 s, before it served.
const FAR_PID = 3_000_000;
// How long a server may take to serve with such a snapshot stored, well
// within the 120 s a server is given to start where it is pooled.
const FAR_START_MS = 45_000;

test.serial(
  "a REPL session snapshotted with PIDs in the millions comes back whole to a server that starts at once, its PID counter left low",
  async () => {
    expect(
      Number(readFileSync("/proc/sys/kernel/pid_max", "utf8")),
    ).toBeGreaterThan(FAR_PID + 1_000);
    const { home, stateDir } = makeHome();
    try {
      let sessionId: string;
      // The counter set at once where the helper may write it: a process
      // started after takes the PID asked for, within seconds, not the
      // minutes a climb there takes.
      const set = await run([
        "timeout",
        "20",
        "docker",
        "run",
        "--rm",
        ...SNAPSHOT_FLAGS,
        ...COUNTER_SETTING_FLAGS,
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        `bayma-advance-pids ${FAR_PID} && sh -c 'echo $$'`,
      ]);
      expect({ exitCode: set.exitCode, output: set.output.trim() }).toEqual({
        exitCode: 0,
        output: String(FAR_PID),
      });
      // Its PIDs where a long-running container's reach, the counter set to
      // them before its server starts, as climbing there would take minutes.
      const first = await serve(home, stateDir, {
        firstPid: FAR_PID,
        settingCounter: true,
      });
      try {
        const created = await first.client.callTool<{
          session: { session_id: string };
        }>("session.create", { runtime: "python", title: "far", cwd: home });
        sessionId = created.session.session_id;
        const defined = await execSettled(
          first.client,
          sessionId,
          "marker = 41",
        );
        expect(defined.status).toBe("ok");
      } finally {
        await first.stop();
      }
      const { maxPid } = JSON.parse(
        readFileSync(join(stateDir, "sessions", `${sessionId}.json`), "utf8"),
      ).processSnapshot;
      expect(maxPid).toBeGreaterThanOrEqual(FAR_PID);

      // A fresh container, its /proc/sys read-only and its counter low.
      const started = Date.now();
      const second = await serve(home, stateDir);
      try {
        await second.client.listTools();
        expect(Date.now() - started).toBeLessThan(FAR_START_MS);
        await second.client.callTool("session.acquire_controller", {
          session_id: sessionId,
        });
        const read = await execSettled(second.client, sessionId, "marker + 1");
        expect({
          status: read.status,
          result: read.result_text?.trim(),
          error: read.error_text || undefined,
        }).toEqual({ status: "ok", result: "42", error: undefined });
        expect(second.client.serverOutput()).toContain(
          "1 process snapshot(s) lie further ahead of the PID counter than a start moves it",
        );
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

test.serial(
  "the image's PID helper refuses a PID its namespace cannot reach, leaving the counter where it was",
  async () => {
    const { home } = makeHome();
    try {
      const helper = await run([
        "docker",
        "run",
        "--rm",
        ...userFlags(home),
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        [
          "before=$(sh -c 'echo $$')",
          "bayma-advance-pids $(cat /proc/sys/kernel/pid_max)",
          'echo "status $?"',
          "after=$(sh -c 'echo $$')",
          'echo "moved $((after - before))"',
        ].join("; "),
      ]);
      // By cat, the helper itself, and the shell that echoes `after`.
      expect(helper.stdout).toBe("status 1\nmoved 3\n");
      expect(helper.output).toMatch(
        /bayma-advance-pids: PID \d+ is not below this namespace's pid_max, \d+\n/,
      );
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

test.serial(
  "a REPL session's runtime the kernel kills for its memory, started fresh or restored from its process snapshot, is said to have run out of its container's, and comes back",
  async () => {
    const { home, stateDir } = makeHome();
    // Its container limited, as a pod is, below what the runtime comes to
    // hold, with no swap to hold it in instead.
    const limited = ["--memory", "768m", "--memory-swap", "768m"];
    const hog =
      "held = bytearray(1024 << 20)\nfor at in range(0, len(held), 4096): held[at] = 1";
    // The exec ends in error saying why, and how what ran it ended: the
    // runtime, of the kernel's SIGKILL; CRIU, which ran a restored one, of
    // itself, as its tree did.
    const killed = (snapshot: ExecSnapshot, ended: string) => ({
      status: snapshot.status,
      killed: snapshot.error_text?.includes(
        `ran out of its memory (768Mi) and was killed by the kernel ${ended}`,
      ),
      snapshot,
    });
    // Its runtime started again, the next exec is told how.
    const cameBack = async (
      client: McpStdioClient,
      sessionId: string,
      started: string,
    ) => {
      const next = await execSettled(client, sessionId, "1 + 1");
      expect({
        status: next.status,
        result: next.result_text?.trim(),
        notice: next.notice,
      }).toMatchObject({
        status: "ok",
        result: "2",
        notice: expect.stringContaining(
          `ran out of its container's memory (768Mi) and was killed by the kernel, so it was started again ${started}`,
        ),
      });
    };
    const python = async (client: McpStdioClient, title: string) =>
      (
        await client.callTool<{ session: { session_id: string } }>(
          "session.create",
          { runtime: "python", title, cwd: home },
        )
      ).session.session_id;
    try {
      let restored: string;
      const first = await serve(home, stateDir, { docker: limited });
      try {
        // A runtime started fresh.
        const fresh = await python(first.client, "fresh");
        expect(
          killed(
            await execSettled(first.client, fresh, hog),
            "(code=null, signal=SIGKILL)",
          ),
        ).toMatchObject({ status: "error", killed: true });
        // Its only exec ended so, it committed no checkpoint.
        await cameBack(first.client, fresh, "afresh");
        await first.client.callTool("session.close", { session_id: fresh });
        // One that holds what the stop snapshots, for the next server to restore.
        restored = await python(first.client, "restored");
        const defined = await execSettled(
          first.client,
          restored,
          "marker = 41",
        );
        expect(defined.status).toBe("ok");
      } finally {
        await first.stop();
      }

      // Restored by CRIU, which runs it, from its process snapshot.
      const second = await serve(home, stateDir, { docker: limited });
      try {
        await second.client.callTool("session.acquire_controller", {
          session_id: restored,
        });
        const read = await execSettled(second.client, restored, "marker + 1");
        expect(read.result_text?.trim()).toBe("42");
        expect(
          killed(
            await execSettled(second.client, restored, hog),
            "(code=0, signal=none)",
          ),
        ).toMatchObject({ status: "error", killed: true });
        await cameBack(
          second.client,
          restored,
          "from its checkpoint committed at",
        );
        await second.client.callTool("session.close", {
          session_id: restored,
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
