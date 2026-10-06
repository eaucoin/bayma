import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Fake `claude` and `codex` commands, for the bayma command's tests: each
// records the arguments it was run with, a line per run, in the file
// FAKE_MCP_CLIENT_LOG names, and succeeds.

export const FAKE_MCP_CLIENT_LOG = "FAKE_MCP_CLIENT_LOG";

/** Writes the fakes into `directory`, which goes on PATH. */
export function writeFakeMcpClients(directory: string): void {
  mkdirSync(directory, { recursive: true });
  for (const name of ["claude", "codex"]) {
    const path = join(directory, name);
    writeFileSync(
      path,
      `#!/bin/sh\necho "${name} $*" >> "$${FAKE_MCP_CLIENT_LOG}"\n`,
    );
    chmodSync(path, 0o755);
  }
}

/** The runs the fakes recorded in `log`, a line each. */
export function fakeMcpClientRuns(log: string): string[] {
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
}
