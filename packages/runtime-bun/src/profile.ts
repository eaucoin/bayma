import type { RuntimeModelProfile } from "@bayma/core";

export const bunModelProfile: RuntimeModelProfile = {
  runtimeId: "bun",
  heading: "Bun",
  description:
    "Runs JavaScript or TypeScript in Bun. Bun.*, top-level await, fetch, imports, and packages available from the session working directory are available. Checkpointed recovery preserves explicit $checkpoint state using Bayma's structured-clone codec. $displayImage(image) shows the model a PNG, JPEG, GIF, or WebP image, from a path, a file URL, or bytes.",
};
