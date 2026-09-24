import { readFileSync } from "node:fs";
import { walkFiles } from "../shared/files.ts";

// Development telemetry stays in development: what bayma publishes, the Node
// bundles and the payload, carries no OpenTelemetry. Each command that
// produces one proves it of what it produced.

const SCOPE = "@opentelemetry/";

/** Throws if the bundle at `path` has OpenTelemetry in it. */
export function assertBundleUntraced(path: string): void {
  if (readFileSync(path, "utf8").includes(SCOPE))
    throw new Error(`${path} bundles OpenTelemetry, which bayma must not ship`);
}

/** Throws if any file under `root` belongs to an OpenTelemetry package. */
export function assertTreeUntraced(root: string): void {
  const found = walkFiles(root).find((path) => path.includes(`/${SCOPE}`));
  if (found)
    throw new Error(`${found} is OpenTelemetry, which bayma must not ship`);
}
