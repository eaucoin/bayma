// The platform bayma's payload is built for: the Linux of its image. A build
// for anything else is not something the product improvises around: it
// refuses.

export const PLATFORM_IDS = ["linux-x64"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: string): value is PlatformId {
  return (PLATFORM_IDS as readonly string[]).includes(value);
}

/** This machine's platform id, or an error naming the one that exists. */
export function hostPlatformId(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformId {
  const id = `${platform}-${arch}`;
  if (isPlatformId(id)) return id;
  throw new Error(`bayma runs on ${PLATFORM_IDS.join(" and ")}, not ${id}`);
}
