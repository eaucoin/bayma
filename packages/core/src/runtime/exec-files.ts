import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ExecFileWorkspace {
  file(filename: string): string;
  dispose(): void;
}

function removeWorkspace(path: string, bestEffort: boolean): void {
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch (error) {
    if (!bestEffort) throw error;
  }
}

function execWorkspaceNamespace(rootDir: string): string {
  const rootHash = createHash("sha256")
    .update(resolve(rootDir))
    .digest("hex")
    .slice(0, 24);
  return join(tmpdir(), "bayma-execs", rootHash);
}

function execWorkspaceDirectory(
  rootDir: string,
  sessionId: string,
  execId: string,
): string {
  const execHash = createHash("sha256")
    .update(`${sessionId}:${execId}`)
    .digest("hex")
    .slice(0, 24);
  return join(execWorkspaceNamespace(rootDir), execHash);
}

function validateExecFilename(filename: string): void {
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    throw new Error(`invalid exec workspace filename: ${filename}`);
  }
}

export function execFilePath(
  rootDir: string,
  sessionId: string,
  execId: string,
  filename: string,
): string {
  validateExecFilename(filename);
  return join(execWorkspaceDirectory(rootDir, sessionId, execId), filename);
}

export function createExecFileWorkspace(
  rootDir: string,
  sessionId: string,
  execId: string,
): ExecFileWorkspace {
  const directory = execWorkspaceDirectory(rootDir, sessionId, execId);
  removeWorkspace(directory, false);
  mkdirSync(directory, { recursive: true });
  let disposed = false;
  return {
    file(filename) {
      if (disposed) throw new Error("exec file workspace is disposed");
      return execFilePath(rootDir, sessionId, execId, filename);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeWorkspace(directory, true);
    },
  };
}

export function removeAllExecFileWorkspaces(rootDir: string): void {
  removeWorkspace(execWorkspaceNamespace(rootDir), false);
}
