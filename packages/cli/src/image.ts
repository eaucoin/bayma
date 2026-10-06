import { type DockerEngine, type PullEvent } from "./docker.ts";
import { IMAGE_DIGEST, IMAGE_REPOSITORY, VERSION } from "./release.ts";

// The image this command runs: the release's, pinned by digest, or, for
// bayma's own tests and CI, the one BAYMA_IMAGE names, such as the
// bayma:<version> that `bun run image` builds. An image BAYMA_IMAGE names is
// never pulled, nor removed by uninstall.

export const IMAGE_OVERRIDE = "BAYMA_IMAGE";

/** The release's image, by digest; undefined for a build with none pinned. */
export function pinnedImage(digest: string = IMAGE_DIGEST): string | undefined {
  return digest ? `${IMAGE_REPOSITORY}@${digest}` : undefined;
}

/** The image `env` has this command run, and whether it is the release's. */
export interface BaymaImage {
  reference: string;
  pinned: boolean;
}

export function baymaImage(
  env: Readonly<Record<string, string | undefined>>,
): BaymaImage {
  const override = env[IMAGE_OVERRIDE];
  if (override) return { reference: override, pinned: false };
  const pinned = pinnedImage();
  if (!pinned)
    throw new Error(
      `this bayma ${VERSION} is a development build, with no image pinned: set ${IMAGE_OVERRIDE} to an image such as bayma:${VERSION}, which bun run image builds`,
    );
  return { reference: pinned, pinned: true };
}

/** The image is here; why not, with what to do, when it is not. */
export function missingImage(image: BaymaImage): string {
  return image.pinned
    ? `bayma's image ${image.reference} is not here: run npx bayma-repl@${VERSION} init`
    : `${IMAGE_OVERRIDE} names ${image.reference}, which Docker does not have`;
}

/** Pulls the release's image unless Docker has it already. */
export async function ensureImage(
  engine: DockerEngine,
  image: BaymaImage,
  report: (event: PullEvent) => void,
): Promise<"present" | "pulled"> {
  if (await engine.inspectImage(image.reference)) return "present";
  if (!image.pinned) throw new Error(missingImage(image));
  await engine.pullImage(IMAGE_REPOSITORY, IMAGE_DIGEST, report);
  return "pulled";
}

const MB = 1_000_000;

/**
 * Reports a pull's progress on `stream`: on a terminal, one line rewritten
 * with how much of the image's layers has come; elsewhere, a line as each
 * layer is pulled.
 */
export function pullReporter(stream: {
  isTTY?: boolean;
  write(text: string): unknown;
}): { event(event: PullEvent): void; end(): void } {
  const layers = new Map<string, { current: number; total: number }>();
  const done = new Set<string>();
  const line = () => {
    let current = 0;
    let total = 0;
    for (const layer of layers.values()) {
      current += layer.current;
      total += layer.total;
    }
    return `pulled ${done.size} of ${layers.size} layers, ${Math.round(current / MB)} of ${Math.round(total / MB)} MB downloaded`;
  };
  return {
    event({ id, status, progressDetail }) {
      if (id === undefined || status === undefined) return;
      const layer = layers.get(id) ?? { current: 0, total: 0 };
      layers.set(id, layer);
      if (status === "Downloading" && progressDetail?.total) {
        layer.current = progressDetail.current ?? 0;
        layer.total = progressDetail.total;
      }
      if (status === "Download complete") layer.current = layer.total;
      const finished =
        (status === "Pull complete" || status === "Already exists") &&
        !done.has(id);
      if (finished) done.add(id);
      if (stream.isTTY) stream.write(`\r\x1b[K${line()}`);
      else if (finished) stream.write(`${line()}\n`);
    },
    end() {
      if (stream.isTTY && layers.size > 0) stream.write("\n");
    },
  };
}
