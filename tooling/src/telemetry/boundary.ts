import { readFileSync } from "node:fs";

// What bayma ships, its Node bundle, carries the telemetry it exports with
// (packages/core/src/telemetry) and no more: nothing of its development's,
// and none of the OpenTelemetry it leaves out, the Node SDK and gRPC. The
// build proves it of the bundle it produced.

/** What must not ship, as the bundle names the modules it holds. */
const UNSHIPPED = [
  ["tooling/src/", "development tooling"],
  ["@opentelemetry/sdk-node", "OpenTelemetry's Node SDK"],
  ["@grpc/", "gRPC"],
] as const;

/** Throws if the bundle at `path` carries what bayma must not ship. */
export function assertBundleShipsOwnTelemetry(path: string): void {
  const bundle = readFileSync(path, "utf8");
  for (const [marker, what] of UNSHIPPED)
    if (bundle.includes(marker))
      throw new Error(`${path} bundles ${what}, which bayma must not ship`);
}
