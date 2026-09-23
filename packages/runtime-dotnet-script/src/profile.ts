import type { RuntimeModelProfile } from "@bayma/core";

export const dotnetScriptModelProfile: RuntimeModelProfile = {
  runtimeId: "dotnet-script",
  heading: "C# (dotnet-script)",
  description:
    "Supports persistent script state, top-level async code, console output, common namespaces, cwd-relative script references, notebook-style multiline submissions, and REPL-style last-expression rendering. Checkpointed recovery preserves explicit bayma_write_checkpoint(...) state using Bayma's JSON codec.",
};
