import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

interface ParsedVersion {
  core: string[];
  prerelease: string[] | null;
}

function parseVersion(version: string): ParsedVersion | null {
  const buildParts = version.split("+");
  if (
    buildParts.length > 2 ||
    (buildParts.length === 2 &&
      !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(buildParts[1]!))
  ) {
    return null;
  }
  const withoutBuild = buildParts[0]!;
  const prereleaseIndex = withoutBuild.indexOf("-");
  const coreText =
    prereleaseIndex === -1
      ? withoutBuild
      : withoutBuild.slice(0, prereleaseIndex);
  const prereleaseText =
    prereleaseIndex === -1 ? null : withoutBuild.slice(prereleaseIndex + 1);
  if (
    !/^\d+(?:\.\d+)*$/.test(coreText) ||
    (prereleaseText !== null &&
      !/^[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(prereleaseText))
  ) {
    return null;
  }
  return {
    core: coreText.split("."),
    prerelease: prereleaseText?.split(".") ?? null,
  };
}

export function isValidVersion(version: string): boolean {
  return parseVersion(version) !== null;
}

function compareNumericIdentifiers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  return (
    normalizedLeft.length - normalizedRight.length ||
    normalizedLeft.localeCompare(normalizedRight)
  );
}

export function compareVersionPrecedence(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) return left.localeCompare(right);

  const maxLength = Math.max(parsedLeft.core.length, parsedRight.core.length);
  for (let index = 0; index < maxLength; index += 1) {
    const delta = compareNumericIdentifiers(
      parsedLeft.core[index] ?? "0",
      parsedRight.core[index] ?? "0",
    );
    if (delta !== 0) return delta;
  }

  if (parsedLeft.prerelease === null || parsedRight.prerelease === null) {
    if (parsedLeft.prerelease === parsedRight.prerelease) {
      return left.localeCompare(right);
    }
    return parsedLeft.prerelease === null ? 1 : -1;
  }
  const maxPrereleaseLength = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < maxPrereleaseLength; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const delta = compareNumericIdentifiers(leftIdentifier, rightIdentifier);
      if (delta !== 0) return delta;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    const delta = leftIdentifier.localeCompare(rightIdentifier);
    if (delta !== 0) return delta;
  }
  return left.localeCompare(right);
}

function parseTfmVersion(tfm: string): [number, number] | null {
  const match = tfm.match(/^net(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function compareTfmVersions(left: string, right: string): number {
  const leftVersion = parseTfmVersion(left);
  const rightVersion = parseTfmVersion(right);
  if (!leftVersion || !rightVersion) return right.localeCompare(left);
  return rightVersion[0] - leftVersion[0] || rightVersion[1] - leftVersion[1];
}

function resolveEmbeddedLibraryDir(toolsRoot: string): string | null {
  const scriptBinaryPath = join(toolsRoot, "dotnet-script");
  if (!existsSync(scriptBinaryPath)) return null;
  const embeddedPath = readFileSync(scriptBinaryPath, "latin1").match(
    /\.store[\\/]+dotnet-script[\\/]+[^\0\r\n]+?[\\/]+tools[\\/]+net\d+\.\d+[\\/]+any[\\/]+dotnet-script\.dll/,
  )?.[0];
  if (!embeddedPath) return null;
  const relativeDir = embeddedPath.replace(/\\/g, "/").split("/").slice(0, -1);
  if (
    relativeDir.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  const candidate = join(toolsRoot, ...relativeDir);
  if (!existsSync(join(candidate, "Dotnet.Script.Core.dll"))) return null;
  const physicalRelative = relative(
    realpathSync(toolsRoot),
    realpathSync(candidate),
  );
  if (
    physicalRelative === ".." ||
    physicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(physicalRelative)
  ) {
    return null;
  }
  return resolve(candidate);
}

export function resolveDotnetScriptLibraryDirFromToolsRoot(
  toolsRoot: string,
): string {
  const embeddedLibraryDir = resolveEmbeddedLibraryDir(toolsRoot);
  if (embeddedLibraryDir) return embeddedLibraryDir;

  const root = join(toolsRoot, ".store", "dotnet-script");
  if (!existsSync(root)) {
    throw new Error("dotnet-script libraries not found");
  }

  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidVersion(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersionPrecedence)
    .reverse();
  for (const version of versions) {
    const base = join(root, version, "dotnet-script", version, "tools");
    if (!existsSync(base)) continue;
    const tfms = readdirSync(base)
      .filter((entry) => parseTfmVersion(entry))
      .sort(compareTfmVersions);
    for (const tfm of tfms) {
      const candidate = join(base, tfm, "any");
      if (existsSync(join(candidate, "Dotnet.Script.Core.dll"))) {
        return resolve(candidate);
      }
    }
  }

  throw new Error("dotnet-script libraries not found");
}
