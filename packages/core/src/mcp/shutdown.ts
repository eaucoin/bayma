import { failureDetail } from "../errors.ts";
import { stopTelemetry } from "../telemetry/index.ts";
import { report, SeverityNumber } from "../telemetry/record.ts";

/**
 * Shuts the server down and exits, once what telemetry holds is exported:
 * the process ends at `process.exit`, which nothing after it outlives.
 */
export function shutdownAndExit(
  shutdown: () => Promise<void>,
  exitCode = 0,
): void {
  void shutdown().then(
    async () => {
      await stopTelemetry();
      process.exit(exitCode);
    },
    async (error) => {
      report(
        `Bayma shutdown failed: ${failureDetail(error)}`,
        {},
        SeverityNumber.ERROR,
      );
      await stopTelemetry();
      process.exit(1);
    },
  );
}
