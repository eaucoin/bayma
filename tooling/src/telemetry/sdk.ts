import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

// The OpenTelemetry SDK, which only telemetry that is configured loads. The
// SDK reads the exporters, their endpoints, protocols, and headers, and the
// rest of its configuration from OpenTelemetry's environment variables; see
// config.ts.

/**
 * Starts the SDK with `attributes` as the resource, beneath what the
 * environment and the SDK's detectors say. Returns what flushes and stops it.
 */
export function startSdk(
  attributes: Record<string, string>,
): () => Promise<void> {
  const sdk = new NodeSDK({ resource: resourceFromAttributes(attributes) });
  sdk.start();
  return () => sdk.shutdown();
}
