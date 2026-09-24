import { spawn } from "node:child_process";
import { basename } from "node:path";
import { ATTR } from "../telemetry/attributes.ts";
import {
  inSpan,
  outputLog,
  recordProcess,
  telemetryEnabled,
  traceEnvironment,
} from "../telemetry/index.ts";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Added to this process's environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Written to the process's standard input, which is otherwise empty. */
  input?: string;
  /**
   * Shows the process's output as it runs, as well as returning it. With
   * telemetry off the process writes to this one's streams directly, and
   * none of its output is returned; with it on, output that reaches a
   * terminal keeps its colours.
   */
  echo?: boolean;
}

/** The most output a process may write before it is stopped. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function environment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...process.env,
    ...overrides,
    // A process that records telemetry continues this one's trace.
    ...traceEnvironment(),
  }))
    if (value !== undefined) merged[name] = value;
  return merged;
}

/**
 * Runs a command to its end. With telemetry on, it is a span, its output
 * lines are log records of that span, and its duration a metric.
 */
export async function run(
  command: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const [file, ...args] = command;
  const executable = basename(file!);
  return inSpan(
    executable,
    {
      [ATTR.processExecutableName]: executable,
      [ATTR.processCommandArgs]: command,
      ...(options.cwd ? { [ATTR.processWorkingDirectory]: options.cwd } : {}),
    },
    async (span) => {
      const started = performance.now();
      const result = await new Promise<RunResult>((resolve, reject) => {
        const direct = options.echo === true && !telemetryEnabled();
        const colours =
          options.echo === true &&
          !direct &&
          process.stdout.isTTY &&
          process.env.FORCE_COLOR === undefined;
        const child = spawn(file!, args, {
          cwd: options.cwd,
          env: environment({
            ...(colours ? { FORCE_COLOR: "1" } : {}),
            ...options.env,
          }),
          stdio: [
            options.input === undefined ? "ignore" : "pipe",
            direct ? "inherit" : "pipe",
            direct ? "inherit" : "pipe",
          ],
        });
        if (child.pid !== undefined)
          span.setAttribute(ATTR.processPid, child.pid);
        const output = { stdout: "", stderr: "" };
        let written = 0;
        for (const iostream of ["stdout", "stderr"] as const) {
          const stream = child[iostream];
          if (!stream) continue;
          const lines = outputLog(iostream, {
            [ATTR.processExecutableName]: executable,
          });
          stream.setEncoding("utf8");
          stream.on("data", (chunk: string) => {
            written += Buffer.byteLength(chunk);
            if (written > MAX_OUTPUT_BYTES) {
              child.kill("SIGKILL");
              reject(
                new Error(
                  `${command.join(" ")} wrote more than ${MAX_OUTPUT_BYTES} bytes`,
                ),
              );
              return;
            }
            output[iostream] += chunk;
            lines?.write(chunk);
            if (options.echo) process[iostream].write(chunk);
          });
          stream.on("end", () => lines?.end());
        }
        child.on("error", reject);
        child.on("close", (code) => resolve({ status: code ?? 1, ...output }));
        child.stdin?.end(options.input);
      });
      recordProcess(
        span,
        executable,
        result.status,
        (performance.now() - started) / 1000,
      );
      return result;
    },
  );
}

/** The last lines of a stream: where a failing tool puts its verdict. */
function tail(output: string, lines = 60): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Throws unless `command` succeeded; the message carries the end of both
 * streams, since test runners report failures on stdout.
 */
export function assertSucceeded(command: string[], result: RunResult): void {
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
}

/** Run a command that must succeed. */
export async function runOrThrow(
  command: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(command, options);
  assertSucceeded(command, result);
  return result;
}
