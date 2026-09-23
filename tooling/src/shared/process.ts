import { spawnSync } from "node:child_process";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export function run(command: string[], options: RunOptions = {}): RunResult {
  const [file, ...args] = command;
  const result = spawnSync(file!, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** The last lines of a stream: where a failing tool puts its verdict. */
function tail(output: string, lines = 60): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Run a command that must succeed; the failure message carries the end of
 * both streams, since test runners report failures on stdout.
 */
export function runOrThrow(
  command: string[],
  options: RunOptions = {},
): RunResult {
  const result = run(command, options);
  if (result.status !== 0) {
    throw new Error(
      [
        `${command.join(" ")} failed with status ${result.status}`,
        tail(result.stdout),
        tail(result.stderr),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}
