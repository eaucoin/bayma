import { join, resolve } from "node:path";
import { hostPlatformId } from "@bayma/core";
import { build } from "./build.ts";
import { assemblePayload } from "./payload.ts";
import { provision, readProvisionRecord } from "./provision/index.ts";
import { pack, writePayloadRelease } from "./publish.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const distDir = join(repoRoot, "dist");
const workDir = join(repoRoot, ".work");

function usage(): never {
  console.error(`usage: bun tooling/src/cli.ts <command>

  build                  bundle the server and the installer for Node into dist
  provision              download and verify every pinned toolchain into .work
  payload                assemble dist/payload and its release tarball
  release [--assets DIR] [--base-url URL] [--host-only]
                         write dist/payloads.json from the payload tarballs in DIR
  pack                   stage the package and npm pack it into dist`);
  process.exit(2);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) usage();
  return value;
}

function requireProvision() {
  const record = readProvisionRecord(workDir);
  if (!record)
    throw new Error("no provisioned toolchains; run `bun run provision` first");
  return record;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "build": {
      const result = build(repoRoot, distDir);
      console.log(`built ${result.bundle} and ${result.installer}`);
      return;
    }
    case "provision": {
      const record = await provision(repoRoot, workDir);
      for (const [runtimeId, payload] of Object.entries(record.payloads)) {
        console.log(`${runtimeId}: ${payload.root}`);
      }
      return;
    }
    case "payload": {
      const result = assemblePayload(repoRoot, requireProvision(), distDir);
      console.log(`${result.tarball}\n${result.sha256}  ${result.bytes} bytes`);
      return;
    }
    case "release": {
      const assets = option(args, "--assets") ?? join(distDir);
      const release = writePayloadRelease(repoRoot, assets, distDir, {
        baseUrl: option(args, "--base-url"),
        ...(args.includes("--host-only")
          ? { platforms: [hostPlatformId()] }
          : {}),
      });
      console.log(
        `${release.version}: ${Object.keys(release.payloads).join(", ")}`,
      );
      return;
    }
    case "pack": {
      const result = pack(repoRoot, distDir);
      console.log(`${result.tarball}\n${result.files.length} files`);
      return;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
