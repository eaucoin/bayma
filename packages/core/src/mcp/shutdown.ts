import { failureDetail } from "../errors.ts";
export function shutdownAndExit(
  shutdown: () => Promise<void>,
  exitCode = 0,
): void {
  void shutdown().then(
    () => process.exit(exitCode),
    (error) => {
      process.stderr.write(`Bayma shutdown failed: ${failureDetail(error)}\n`);
      process.exit(1);
    },
  );
}
