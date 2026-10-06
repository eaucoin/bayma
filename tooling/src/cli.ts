import { join, resolve } from "node:path";
import { build } from "./build.ts";
import { buildCli } from "./cli-package.ts";
import { buildImage } from "./image.ts";
import { assemblePayload } from "./payload.ts";
import { provision, readProvisionRecord } from "./provision/index.ts";
import { pinRelease } from "./release.ts";
import { run } from "./shared/process.ts";
import { bunJUnitReport, runTests } from "./shared/tests.ts";
import { inCommand, startTelemetry, stopTelemetry } from "./telemetry/index.ts";
import { ensureToolchains, pullToolchains } from "./toolchains.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const distDir = join(repoRoot, "dist");
const workDir = join(repoRoot, ".work");

function usage(): never {
  console.error(`usage: bun tooling/src/cli.ts <command>

  build                  bundle the server for Node into dist, and the bayma
                         command into packages/cli/dist
  pin DIGEST             pin the bayma command to the image of DIGEST, as a
                         release does once it has pushed the image
  provision              download and verify every pinned toolchain into .work
  toolchains pull        restore every toolchain into .work from its image on
                         GitHub's container registry, as provision leaves
                         them; fails, building none, if an image is missing
  toolchains ensure      push an image of every toolchain the registry lacks,
                         provisioned from the images of the rest, and prune
                         each one's older versions; GITHUB_TOKEN writes them
  payload                assemble dist/payload
  image                  build and tag the image from dist and the Dockerfile
  test [ARGS...]         bun test with ARGS
  typecheck              type-check every TypeScript project
  format [--check]       format the repository, or check that it is formatted

Every command records OpenTelemetry traces, metrics, and logs when the
environment, or the otel.env its bun run script loads, configures an
exporter; see otel.env.example and packages/core/src/telemetry/config.ts.`);
  process.exit(2);
}

function requireProvision() {
  const record = readProvisionRecord(workDir);
  if (!record)
    throw new Error("no provisioned toolchains; run `bun run provision` first");
  return record;
}

/** Runs each command in turn, showing its output, until one fails. */
async function runEach(commands: string[][]): Promise<number> {
  for (const command of commands) {
    const { status } = await run(command, { cwd: repoRoot, echo: true });
    if (status !== 0) return status;
  }
  return 0;
}

/** Each command, by name: what it does, and the status it exits with. */
const COMMANDS: Record<string, (args: string[]) => Promise<number>> = {
  async build() {
    const result = await build(repoRoot, distDir);
    console.log(`built ${result.bundle}`);
    const cli = await buildCli(repoRoot);
    console.log(`built ${cli.bundle}`);
    return 0;
  },
  async pin([digest, ...rest]) {
    if (digest === undefined || rest.length > 0) usage();
    console.log(`pinned ${digest} in ${pinRelease(repoRoot, digest)}`);
    return 0;
  },
  async provision() {
    const record = await provision(repoRoot, workDir);
    for (const [runtimeId, payload] of Object.entries(record.payloads)) {
      console.log(`${runtimeId}: ${payload.root}`);
    }
    return 0;
  },
  async toolchains([action, ...rest]) {
    if (rest.length > 0) usage();
    if (action === "pull") {
      const pinned = await pullToolchains(repoRoot, workDir);
      for (const [name, image] of Object.entries(pinned))
        console.log(`${name}: ${image}`);
      return 0;
    }
    if (action === "ensure") {
      const token = process.env.GITHUB_TOKEN;
      if (!token)
        throw new Error("GITHUB_TOKEN must name a token that writes packages");
      const outcomes = await ensureToolchains(repoRoot, workDir, token);
      for (const [name, outcome] of Object.entries(outcomes))
        console.log(`${name}: ${outcome}`);
      return 0;
    }
    usage();
  },
  async payload() {
    console.log(assemblePayload(repoRoot, requireProvision(), distDir));
    return 0;
  },
  async image() {
    for (const tag of await buildImage(repoRoot, distDir)) console.log(tag);
    return 0;
  },
  async test(args) {
    const { status } = await runTests(
      "bun",
      ["bun", "test", ...args],
      bunJUnitReport,
      { cwd: repoRoot, echo: true },
    );
    return status;
  },
  async typecheck() {
    return runEach([
      ["tsc", "-p", "tsconfig.json"],
      ["tsc", "-p", "tsconfig.bun.json"],
    ]);
  },
  async format(args) {
    return runEach([
      ["prettier", args.includes("--check") ? "--check" : "--write", "."],
    ]);
  },
};

/** A command that ran and reported its own failure, with its status. */
class CommandFailed extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`exited with status ${status}`);
    this.name = "CommandFailed";
    this.status = status;
  }
}

async function main(): Promise<number> {
  const [name, ...args] = process.argv.slice(2);
  if (name === undefined || !Object.hasOwn(COMMANDS, name)) usage();
  const command = COMMANDS[name];
  await startTelemetry();
  try {
    return await inCommand(name, async () => {
      const status = await command(args);
      if (status !== 0) throw new CommandFailed(status);
      return status;
    });
  } catch (error) {
    if (error instanceof CommandFailed) return error.status;
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    await stopTelemetry();
  }
}

process.exitCode = await main();
