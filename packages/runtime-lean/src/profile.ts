import type { RuntimeModelProfile } from "@bayma/core";

export const leanModelProfile: RuntimeModelProfile = {
  runtimeId: "lean",
  heading: "Lean",
  description:
    "Runs Lean 4 commands. Each cell runs on the environment the previous cell left, so its definitions, theorems, instances, and attributes stay in scope; imports belong in a session's first cell. A cell's last info message, such as a final #eval's value or a #check, is its result; its earlier ones, such as what an #eval printed, are its stdout. Warnings go to stderr and errors end the cell, each with its line:column. A Lake project in the session working directory supplies its libraries, such as Mathlib, once built with the lake on PATH, whose Lean its lean-toolchain must name. An interrupt restarts the session. Checkpointed recovery restores everything the session declared, with its open namespaces, options, and variables.",
};
