import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PathEnvironment } from "../paths.ts";
import { PAYLOAD_MANIFEST } from "./payload-environment.ts";

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

/** The payload directory, which must hold a payload. */
export function requirePayloadDir(env: PathEnvironment = process.env): string {
  const directory = payloadDir(env);
  if (!existsSync(join(directory, PAYLOAD_MANIFEST))) {
    throw new Error(
      `BAYMA_PAYLOAD_DIR holds no ${PAYLOAD_MANIFEST}: ${directory}`,
    );
  }
  return directory;
}
