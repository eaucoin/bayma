import type { RuntimeModelProfile } from "@bayma/core";

export const dotnetScriptModelProfile: RuntimeModelProfile = {
  runtimeId: "dotnet-script",
  heading: "C# (dotnet-script)",
  description:
    "Supports persistent script state, top-level async code, console output, common namespaces, cwd-relative script references, notebook-style multiline submissions, and REPL-style last-expression rendering. Checkpointed recovery preserves explicit bayma_write_checkpoint(...) state using Bayma's JSON codec. bayma_display_image(path) or bayma_display_image(bytes) shows the model a PNG, JPEG, GIF, or WebP image. The session's process keeps every cell it compiled, each costing more memory the longer the session runs: once a cell has ended, one that has come to hold more memory of its own than the server's runtime memory budget past what it held as it started, 2 GiB unless the server is told otherwise, is started again from the session's checkpoint, and the next cell is told so.",
};
