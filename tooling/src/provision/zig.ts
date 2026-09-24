import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM, type PlatformPins } from "../platforms.ts";
import { fetchPinned } from "../shared/download.ts";
import { runOrThrow } from "../shared/process.ts";
import {
  isProvisioned,
  markProvisioned,
  resetDirectory,
  type ProvisionContext,
} from "./payload.ts";

// The pinned zig, unpacked once for every provisioner that compiles or links
// against the glibc floor. Linux only: macOS builds with Apple's clang.

export async function provisionZig(
  context: ProvisionContext,
  pin: NonNullable<PlatformPins["zig"]>,
): Promise<string> {
  const directory = join(context.workDir, "zig");
  if (isProvisioned(context, directory, pin.sha256)) return directory;
  resetDirectory(directory);
  mkdirSync(directory, { recursive: true });
  const archive = await fetchPinned(pin, context.downloadsDir, "zig");
  await runOrThrow([
    "tar",
    "-xJf",
    archive,
    "-C",
    directory,
    "--strip-components=1",
  ]);
  const version = (
    await runOrThrow([join(directory, "zig"), "version"])
  ).stdout.trim();
  if (version !== pin.zigVersion) throw new Error(`zig reports ${version}`);
  markProvisioned(directory, pin.sha256);
  return directory;
}

/** The target zig compiles for: this platform at its glibc floor. */
export function zigTarget(): string {
  return `${PLATFORM.rustTarget.replace("unknown-", "")}.${PLATFORM.glibcFloor}`;
}
