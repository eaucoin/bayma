import type { RuntimeModelProfile } from "@bayma/core";

export const rustModelProfile: RuntimeModelProfile = {
  runtimeId: "rust",
  heading: "Rust",
  description:
    'Runs through EVcxR with real Rust ownership and borrowing. Items, imports, variables, and dependencies can persist. Add Cargo dependencies with :dep package = "version"; :lockfile path/to/Cargo.lock resolves them against that lockfile, keeping its versions, yanked ones included, and :lockfile alone stops. Checkpointed recovery preserves only serde-compatible values explicitly written through bayma_rust_support; Bayma never replays prior cells or their side effects. A panic, unsafe crash, or forced interrupt can replace the execution child and lose non-checkpointed values. Join threads and child processes before a cell returns; interactive stdin and causally attributed output from detached writers are unavailable.',
};
