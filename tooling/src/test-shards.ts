import { readdirSync } from "node:fs";
import { join } from "node:path";

/** What `bun run test` runs: every test file under these directories. */
export const TEST_ROOTS = ["tests/unit", "tests/integration", "tests/tooling"];

const INTEGRATION = "tests/integration";

/**
 * The same test files, in shards that CI runs side by side, each about as
 * long as the others: the quick suites with MCP's, the checkpoint suites,
 * and every other integration suite, which the runtimes' dominate. Each
 * names directories, or files, as `bun test` takes them.
 */
export function testShards(repoRoot: string): Record<string, string[]> {
  const own = ["mcp", "checkpoint"];
  return {
    unit: ["tests/unit", "tests/tooling", `${INTEGRATION}/mcp`],
    checkpoint: [`${INTEGRATION}/checkpoint`],
    integration: readdirSync(join(repoRoot, INTEGRATION))
      .filter((name) => !own.includes(name))
      .sort()
      .map((name) => `${INTEGRATION}/${name}`),
  };
}
