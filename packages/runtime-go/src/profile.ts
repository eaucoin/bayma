import type { RuntimeModelProfile } from "@bayma/core";

export const goModelProfile: RuntimeModelProfile = {
  runtimeId: "go",
  heading: "Go",
  description:
    "Runs Go as one package that grows a cell at a time, in a process that stays alive: each cell may hold imports, then declarations and statements in any order; its statements run once, and everything it declares, unexported names, fields, and methods included, stays live for later cells, while a name declared again replaces the old one. A cell ending in an expression returns its value. Any package may be imported, the session working directory's module among them; modules come through the Go module proxy, and a module's version is fixed once the session has loaded it. The first session on a machine compiles Go's standard library for its cells, once. Output written while no cell runs is dropped. An interrupt, or a panic in a goroutine a cell started, restarts the session. Checkpointed recovery preserves explicit bayma_write_checkpoint(value) state as JSON, read back with bayma_read_checkpoint(&value).",
};
