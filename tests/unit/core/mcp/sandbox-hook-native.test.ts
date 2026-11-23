import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sandboxHookSocket } from "@bayma/core";
import { launchSpec } from "../../../support/runtimes.ts";
import { SOCKET_TEMP_ROOT, withTempDir } from "../../../support/temp.ts";

// The image's sandbox hook without Node (packages/core/native/sandbox-hook.c),
// built as the image builds it, run beside `bayma sandbox-hook`, each a
// process of its own given the same arguments, variables and working
// directory: what each tells the server, prints, says on stderr and exits
// with must be the same.

const SOURCE = resolve(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "core",
  "native",
  "sandbox-hook.c",
);
const MODE_VARIABLE = "GVISOR_SAVE_RESTORE_AUTO_EXEC_MODE";
const STOP_REASON_VARIABLE = "BAYMA_SANDBOX_STOP_REASON";
let built: string;
let buildDir: string;

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "bayma-sandbox-hook-"));
  built = join(buildDir, "bayma-sandbox-hook");
  const compiled = Bun.spawnSync([
    "cc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-o",
    built,
    SOURCE,
  ]);
  expect(compiled.stderr.toString()).toBe("");
  expect(compiled.exitCode).toBe(0);
});

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

/** A temporary state directory short enough for the hook's socket, wherever TMPDIR is. */
function withHookDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  return withTempDir(fn, SOCKET_TEMP_ROOT) as Promise<T>;
}

/**
 * A server on the hook's socket of `dir` that answers every request with
 * `answer`, and the requests it heard.
 */
async function fakeServer(
  dir: string,
  answer: string,
): Promise<{ heard: string[]; close: () => Promise<void> }> {
  const heard: string[] = [];
  const server = net.createServer((socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
      if (!request.includes("\n")) return;
      heard.push(request);
      socket.end(answer);
    });
  });
  await new Promise<void>((listening) =>
    server.listen(sandboxHookSocket(dir), listening),
  );
  return {
    heard,
    close: () => new Promise((closed) => server.close(() => closed())),
  };
}

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

/** How `command`, given `args`, the variables `env` and the working directory `cwd`, ran. */
async function run(
  command: string[],
  args: string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<Ran> {
  const child = Bun.spawn([...command, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

const nodeHook = (): string[] => {
  const launch = launchSpec();
  return [launch.command, ...launch.args, "sandbox-hook"];
};

/** Where a case runs the hooks: the state directory they are given, the working directory, and what puts it back. */
interface Arranged {
  stateDir?: string;
  cwd?: string;
  undo?: () => void;
}

/**
 * Runs both hooks, given `args`, where STATE stands for the state directory,
 * and `env`, from `cwd` (the state directory unless given), against a server
 * answering `answer` (none if null), and expects them to agree: on what the
 * server heard, what they printed and said, and how they exited. Returns
 * what the native hook did.
 */
async function agree(
  args: string[],
  env: Readonly<Record<string, string>>,
  answer: string | null = "ok\n",
  arrange: (dir: string) => Arranged = () => ({}),
): Promise<Ran & { heard: string[] }> {
  return withHookDir(async (dir) => {
    const { stateDir = dir, cwd = dir, undo } = arrange(dir);
    const given = args.map((arg) => (arg === "STATE" ? stateDir : arg));
    const server = answer === null ? null : await fakeServer(dir, answer);
    try {
      const node = await run(nodeHook(), given, env, cwd);
      const heardByNode = server?.heard.splice(0) ?? [];
      const native = await run([built], given, env, cwd);
      expect(server?.heard ?? []).toEqual(heardByNode);
      expect(native).toEqual(node);
      return { ...native, heard: server?.heard ?? [] };
    } finally {
      await server?.close();
      undo?.();
    }
  });
}

test("each mode, named first or in gVisor's variable, is told to the server as the Node hook tells it", async () => {
  for (const mode of ["save", "restore", "resume", "stop"]) {
    expect(
      (await agree(["--state-dir", "STATE"], { [MODE_VARIABLE]: mode })).heard,
    ).toEqual([`${mode}\n`]);
    expect(
      (await agree([mode, "--state-dir", "STATE"], { [MODE_VARIABLE]: "stop" }))
        .heard,
    ).toEqual([`${mode}\n`]);
  }
});

test("a save is told it leaves the sandbox running, and a restore why its host stopped it, and no other mode either", async () => {
  const reason = "it ran out of its memory (4Gi)";
  expect(
    (
      await agree(["save", "--state-dir", "STATE", "--leave-running"], {
        [STOP_REASON_VARIABLE]: reason,
      })
    ).heard,
  ).toEqual(["save leave-running\n"]);
  expect(
    (
      await agree(["--leave-running", "restore", "--state-dir", "STATE"], {
        [STOP_REASON_VARIABLE]: reason,
      })
    ).heard,
  ).toEqual([`restore ${reason}\n`]);
  expect(
    (
      await agree(["resume", "--state-dir", "STATE", "--leave-running"], {
        [STOP_REASON_VARIABLE]: reason,
      })
    ).heard,
  ).toEqual(["resume\n"]);
  // An empty reason is none; the longest, in bytes, is told whole.
  expect(
    (
      await agree(["restore", "--state-dir", "STATE"], {
        [STOP_REASON_VARIABLE]: "",
      })
    ).heard,
  ).toEqual(["restore\n"]);
  const longest = "é".repeat(128);
  expect(
    (
      await agree(["restore", "--state-dir", "STATE"], {
        [STOP_REASON_VARIABLE]: longest,
      })
    ).heard,
  ).toEqual([`restore ${longest}\n`]);
});

test("what the server answers is printed, and what it could not do failed with, as the Node hook does", async () => {
  const caught = JSON.stringify({
    generation: 7,
    running: Array.from({ length: 2_000 }, (_, exec) => ({
      sessionId: "sess_a",
      execId: `exec_${exec}`,
    })),
  });
  expect(
    (await agree(["save", "--state-dir", "STATE"], {}, `ok ${caught}\n`))
      .stdout,
  ).toBe(`${caught}\n`);
  expect(
    (await agree(["save", "--state-dir", "STATE"], {}, "ok \n")).stdout,
  ).toBe("\n");
  for (const answer of ["storage is gone\n", "", "ok", "okay\n", "ok x"]) {
    const failed = await agree(["save", "--state-dir", "STATE"], {}, answer);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toStartWith("the bayma server of ");
  }
});

test("arguments and variables the Node hook refuses, the native one refuses with the same words, telling the server nothing", async () => {
  for (const [args, env] of [
    [["--state-dir", "STATE", "--leave-running", "--leave-running"], {}],
    [["save", "--state-dir", "STATE", "--state-dir", "STATE"], {}],
    [["save", "--state", "STATE"], {}],
    [["save", "--state-dir"], {}],
    [["save", "--state-dir", "--other"], {}],
    [["--state-dir", "--state-dir"], {}],
    [["save"], {}],
    [[], {}],
    [["--state-dir", "STATE"], {}],
    [["--state-dir", "STATE"], { [MODE_VARIABLE]: "checkpoint" }],
    [["Save", "--state-dir", "STATE"], {}],
    [["restore", "--state-dir", "STATE"], { [STOP_REASON_VARIABLE]: "a\nb" }],
    [["restore", "--state-dir", "STATE"], { [STOP_REASON_VARIABLE]: "a\rb" }],
    [
      ["restore", "--state-dir", "STATE"],
      { [STOP_REASON_VARIABLE]: `${"é".repeat(128)}.` },
    ],
  ] as const) {
    const native = await agree([...args], env);
    expect(native.status).toBe(1);
    expect(native.heard).toEqual([]);
  }
});

test("a state directory named relative, empty, through a link, or as its server's root, is the one the Node hook resolves", async () => {
  const save = ["save", "--state-dir", "STATE"];
  // Relative to the working directory, empty as the working directory itself.
  for (const named of ["state", "./state/../state/", ""])
    expect(
      (
        await agree(save, {}, "ok\n", (dir) => {
          const state = join(dir, "state");
          mkdirSync(state);
          // The server listens in `dir`: an empty name runs from there.
          return named === ""
            ? { stateDir: "", cwd: dir }
            : { stateDir: named, cwd: dir };
        })
      ).status,
    ).toBe(named === "" ? 0 : 1);
  // A link to the directory the server listens in, and a link to a link.
  expect(
    (
      await agree(save, {}, "ok\n", (dir) => {
        const links = join(dir, "links");
        mkdirSync(links);
        symlinkSync(dir, join(links, "a"));
        symlinkSync("a", join(links, "b"));
        return { stateDir: join(links, "b", ".") };
      })
    ).heard,
  ).toEqual(["save\n"]);
});

test("a state directory or a socket the hook cannot reach fails both hooks with the same words", async () => {
  const save = ["save", "--state-dir", "STATE"];
  const cases: ((dir: string) => Arranged)[] = [
    // Not there, nor a directory under it.
    (dir) => ({ stateDir: join(dir, "missing", "deeper") }),
    // There, but with no server in it.
    (dir) => {
      mkdirSync(join(dir, "empty"));
      return { stateDir: join(dir, "empty") };
    },
    // A file, not a directory.
    (dir) => {
      writeFileSync(join(dir, "file"), "");
      return { stateDir: join(dir, "file") };
    },
    // A socket file no server listens on, and a file that is no socket.
    (dir) => {
      mkdirSync(join(dir, "plain"));
      writeFileSync(join(dir, "plain", "sandbox-hook.sock"), "");
      return { stateDir: join(dir, "plain") };
    },
    // A directory the hook may not look into.
    (dir) => {
      mkdirSync(join(dir, "closed"));
      chmodSync(join(dir, "closed"), 0o000);
      return {
        stateDir: join(dir, "closed", "inside"),
        undo: () => chmodSync(join(dir, "closed"), 0o700),
      };
    },
    // A link to nowhere.
    (dir) => {
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
      return { stateDir: join(dir, "dangling") };
    },
    // Links to each other, beneath the state directory named.
    (dir) => {
      symlinkSync(join(dir, "loop-b"), join(dir, "loop-a"));
      symlinkSync(join(dir, "loop-a"), join(dir, "loop-b"));
      return { stateDir: join(dir, "loop-a", "inside") };
    },
    // Paths a Unix socket cannot be at, and the longest that it can.
    ...[106, 107, 120].map((length) => (dir: string) => {
      const name = join(dir, "d").padEnd(
        length - "/sandbox-hook.sock".length,
        "d",
      );
      mkdirSync(name, { recursive: true });
      return { stateDir: name };
    }),
  ];
  for (const arrange of cases) {
    const native = await agree(save, {}, null, arrange);
    expect(native.status).toBe(1);
  }
});
