import type { RuntimeId } from "./id.ts";

/** What the model is told about one runtime, in the server's instructions. */
export interface RuntimeModelProfile {
  runtimeId: RuntimeId;
  heading: string;
  description: string;
}
