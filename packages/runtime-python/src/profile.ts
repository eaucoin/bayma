import type { RuntimeModelProfile } from "@bayma/core";

export const pythonModelProfile: RuntimeModelProfile = {
  runtimeId: "python",
  heading: "Python",
  description:
    "Preserves Python globals and imports. Imports, packages available from the session working directory, and top-level await in async code are available. Checkpointed recovery preserves explicit bayma_write_checkpoint(...) state using Bayma's pickle codec. bayma_display_image(image) shows the model a PNG, JPEG, GIF, or WebP image, from a path, bytes, or an object that renders as one, such as a PIL image or a matplotlib figure.",
};
