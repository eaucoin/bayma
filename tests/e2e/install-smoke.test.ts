import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  doctorSuccessOutput,
  hostPlatformId,
  RUNTIME_IDS,
  type RuntimeId,
} from "@bayma/core";
import { writePayloadRelease } from "../../tooling/src/publish.ts";
import {
  McpStdioClient,
  waitForSettledExec,
  type ExecSnapshot,
} from "../support/mcp-stdio-client.ts";
import { expectExactMcpSurface } from "../support/mcp-surface.ts";
import {
  PYTHON_STREAM_CONTRACT_STDERR,
  PYTHON_STREAM_CONTRACT_STDOUT,
  pythonStreamContractProbe,
} from "../support/python-stream-contract.ts";
import { nodeExecutable } from "../support/runtimes.ts";

// The whole install story: npm installs the packed tarball, its postinstall
// downloads the pinned payload and verifies its digest, and every runtime
// then runs from that payload on a machine that offers no toolchain of its
// own. The release is served locally so the download path is exercised for
// real rather than mocked.

const repoRoot = resolve(import.meta.dir, "..", "..");
const distDir = join(repoRoot, "dist");
const INSTALL_TIMEOUT_MS = 1_800_000;

function packedTarball(): string {
  const tarballs = existsSync(distDir)
    ? readdirSync(distDir).filter((name) =>
        /^bayma-repl-bayma-\d.*\.tgz$/.test(name),
      )
    : [];
  if (tarballs.length !== 1) {
    throw new Error(
      `expected exactly one package tarball in ${distDir}; run bun run pack`,
    );
  }
  return join(distDir, tarballs[0]!);
}

/** A machine with no toolchains: node, the system directories, and nothing else. */
function bareEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: [dirname(nodeExecutable()), "/usr/bin", "/bin"].join(":"),
    LANG: process.env.LANG ?? "C.UTF-8",
    TMPDIR: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
  };
}

/**
 * Spawned asynchronously on purpose: the release server below runs in this
 * process, and a synchronous spawn would block the loop that serves it.
 */
async function run(
  command: string[],
  options: { env: Record<string, string>; cwd: string },
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, output: stdout + stderr };
}

function smokeCode(runtimeId: RuntimeId): string {
  switch (runtimeId) {
    case "bun":
      return 'for (const line of ["alpha", "beta"]) console.log(line)\nawait new Promise((resolve) => setTimeout(resolve, 20))\n40 + 2';
    case "python":
      return 'for line in ["alpha", "beta"]:\n    print(line)\nimport asyncio\nawait asyncio.sleep(0.02)\n40 + 2';
    case "dotnet-script":
      return 'System.Console.WriteLine("alpha")\nSystem.Console.WriteLine("beta")\nawait System.Threading.Tasks.Task.Delay(20)\n40 + 2';
    case "rust":
      return 'for line in ["alpha", "beta"] { println!("{}", line); }\nstd::thread::sleep(std::time::Duration::from_millis(20));\n40 + 2';
  }
}

test.serial(
  "npm installs the package, which downloads its payload and runs every runtime",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "bayma-install-smoke-"));
    const home = join(root, "home");
    const prefix = join(root, "prefix");
    mkdirSync(home, { recursive: true });
    mkdirSync(prefix, { recursive: true });
    const env = bareEnvironment(home);
    // Serve dist as this release, so the package downloads the payload it
    // would download from GitHub, digest and all.
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const name = new URL(request.url).pathname.slice(1);
        const asset = join(distDir, name);
        if (!name || name.includes("/") || !existsSync(asset)) {
          return new Response("not found", { status: 404 });
        }
        return new Response(Bun.file(asset));
      },
    });
    try {
      writePayloadRelease(repoRoot, distDir, distDir, {
        baseUrl: `http://127.0.0.1:${server.port}`,
        platforms: [hostPlatformId()],
      });
      const packed = await run(["bun", "run", "pack"], {
        env: process.env as Record<string, string>,
        cwd: repoRoot,
      });
      expect(packed.exitCode).toBe(0);

      // --foreground-scripts so the postinstall download is visible: npm
      // hides script output, and this test exists to prove it happened.
      const install = await run(
        [
          "npm",
          "install",
          "--no-audit",
          "--no-fund",
          "--foreground-scripts",
          packedTarball(),
        ],
        { env, cwd: prefix },
      );
      expect(install.output).not.toContain("could not be installed");
      expect(install.output).toContain("bayma: payload ready");
      expect(install.exitCode).toBe(0);
      const bayma = join(prefix, "node_modules", ".bin", "bayma");
      expect(existsSync(bayma)).toBe(true);
      // postinstall put the payload in place before anything ran.
      const payload = join(
        home,
        "cache",
        "bayma",
        "payloads",
        JSON.parse(readFileSync(join(distDir, "payloads.json"), "utf8"))
          .version,
      );
      expect(existsSync(join(payload, "payload.json"))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(payload, "payload.json"), "utf8"))
          .platform,
      ).toBe(hostPlatformId());
      // ...and linked its toolbelt where the bayma-toolbelt skill looks.
      expect(
        realpathSync(join(home, ".local", "share", "bayma", "toolbelt")),
      ).toBe(realpathSync(join(payload, "toolbelt")));

      const doctor = await run([bayma, "doctor", "--format", "json"], {
        env,
        cwd: root,
      });
      expect(doctor.exitCode).toBe(0);
      expect(doctor.output).toBe(doctorSuccessOutput(RUNTIME_IDS) + "\n");

      const client = await McpStdioClient.launch(
        { command: bayma, args: [], binaryLabel: "bayma" },
        { env, stateDir: join(root, "mcp-state") },
      );
      try {
        expectExactMcpSurface({
          tools: await client.listTools(),
          resourceTemplates: await client.listResourceTemplates(),
          resources: await client.listResources(),
        });
        for (const runtimeId of RUNTIME_IDS) {
          const created = await client.callTool<{
            session: { session_id: string; runtime: RuntimeId };
          }>("session.create", {
            runtime: runtimeId,
            title: `install-smoke-${runtimeId}`,
            cwd: root,
          });
          const sessionId = created.session.session_id;
          expect(created.session.runtime).toBe(runtimeId);
          const submitted = await client.callTool<ExecSnapshot>("exec", {
            session_id: sessionId,
            code: smokeCode(runtimeId),
            yield_time_ms: 500,
          });
          const settled = await waitForSettledExec(
            client,
            sessionId,
            submitted,
            {
              timeoutMs: 240_000,
            },
          );
          expect(settled.status).toBe("ok");
          expect(settled.runtime).toBe(runtimeId);
          expect(settled.stdout_text).toContain("alpha");
          expect(settled.stdout_text).toContain("beta");
          expect(settled.result_text?.trim()).toBe("42");
          if (runtimeId === "python") {
            const probe = await waitForSettledExec(
              client,
              sessionId,
              await client.callTool<ExecSnapshot>("exec", {
                session_id: sessionId,
                code: [pythonStreamContractProbe(), "40 + 2"].join("\n"),
                yield_time_ms: 1_000,
              }),
              { timeoutMs: 60_000 },
            );
            expect(probe.status).toBe("ok");
            expect(probe.stdout_text).toBe(PYTHON_STREAM_CONTRACT_STDOUT);
            expect(probe.stderr_text).toBe(PYTHON_STREAM_CONTRACT_STDERR);
          }
          await client.callTool("session.close", { session_id: sessionId });
        }
      } finally {
        await client.close();
      }
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  INSTALL_TIMEOUT_MS,
);
