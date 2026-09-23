import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { cacheRoot } from "../paths.ts";

export function ensureRuntimeAssetInDirectory(
  directory: string,
  filename: string,
  content: string,
): string {
  if (!filename || basename(filename) !== filename) {
    throw new Error(`runtime asset filename must be one basename: ${filename}`);
  }
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 24);
  const assetPath = join(directory, `${hash}-${filename}`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(assetPath)) {
    const tempPath = join(
      directory,
      `.${hash}-${process.pid}-${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
      try {
        renameSync(tempPath, assetPath);
      } catch (error) {
        if (!existsSync(assetPath)) throw error;
      }
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
  const asset = lstatSync(assetPath);
  const expectedBytes = Buffer.byteLength(content);
  if (
    !asset.isFile() ||
    asset.size !== expectedBytes ||
    readFileSync(assetPath, "utf8") !== content
  ) {
    throw new Error(`runtime asset content does not match ${assetPath}`);
  }
  return assetPath;
}

export function ensureRuntimeAsset(
  runtimeId: string,
  filename: string,
  content: string,
): string {
  const directory = join(cacheRoot(), "assets", runtimeId);
  return ensureRuntimeAssetInDirectory(directory, filename, content);
}
