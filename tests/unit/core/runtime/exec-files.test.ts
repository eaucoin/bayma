import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import {
  createExecFileWorkspace,
  removeAllExecFileWorkspaces,
  type RuntimeAdapter,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { pythonAdapter } from "@bayma/runtime-python";
import { dotnetScriptAdapter } from "@bayma/runtime-dotnet-script";
import { goAdapter } from "@bayma/runtime-go";
import { leanAdapter } from "@bayma/runtime-lean";
import { rustAdapter } from "@bayma/runtime-rust";
import { withTempDir } from "../../../support/temp.ts";

const adapters: RuntimeAdapter[] = [
  bunAdapter,
  pythonAdapter,
  dotnetScriptAdapter,
  rustAdapter,
  leanAdapter,
  goAdapter,
];

test("exec file workspaces are removed by every runtime adapter", async () => {
  await withTempDir(async (rootDir) => {
    for (const adapter of adapters) {
      const prepared = adapter.prepareExec({
        rootDir,
        sessionId: `sess_${adapter.runtimeId}`,
        execId: `exec_${adapter.runtimeId}`,
        code: "40 + 2",
        durabilityMode: "ephemeral",
      });
      const submissionPath = prepared.submitText.trim().split(" ").at(-1)!;
      expect(existsSync(submissionPath)).toBe(true);
      expect(prepared.dispose).toBeFunction();

      prepared.dispose!();
      expect(existsSync(submissionPath)).toBe(false);
      expect(() => prepared.dispose!()).not.toThrow();
    }
  });
});

test("startup cleanup removes workspaces abandoned by an earlier process", async () => {
  await withTempDir(async (rootDir) => {
    const workspace = createExecFileWorkspace(rootDir, "sess_old", "exec_old");
    const abandonedPath = workspace.file("submission.txt");
    writeFileSync(abandonedPath, "abandoned", "utf8");
    expect(existsSync(abandonedPath)).toBe(true);

    removeAllExecFileWorkspaces(rootDir);
    expect(existsSync(abandonedPath)).toBe(false);
    expect(() => workspace.dispose()).not.toThrow();
  });
});
