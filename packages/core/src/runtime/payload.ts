import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PathEnvironment } from "../paths.ts";
import { PAYLOAD_MANIFEST } from "./payload-environment.ts";
import { installToolbelt } from "./toolbelt.ts";

/**
 * bayma runs every runtime from its payload: the pinned toolchains and the
 * toolbelt built against them. bayma's image carries the payload and names it
 * in `BAYMA_PAYLOAD_DIR`; a development build names `dist/payload`.
 */

export function payloadDir(env: PathEnvironment = process.env): string {
  const directory = env.BAYMA_PAYLOAD_DIR;
  if (!directory) {
    throw new Error(
      "BAYMA_PAYLOAD_DIR is not set: bayma runs from its image, which names the payload it carries",
    );
  }
  return directory;
}

/**
 * The payload directory, with its toolbelt installed where the runtime skills
 * name it.
 */
export function preparePayload(
  env: PathEnvironment = process.env,
  report: (message: string) => void = (message) =>
    process.stderr.write(message + "\n"),
): string {
  const directory = payloadDir(env);
  if (!existsSync(join(directory, PAYLOAD_MANIFEST))) {
    throw new Error(
      `BAYMA_PAYLOAD_DIR holds no ${PAYLOAD_MANIFEST}: ${directory}`,
    );
  }
  installToolbelt(directory, env, report);
  return directory;
}
