import { readFileSync } from "node:fs";

/**
 * The token the file at `path` holds, `name`d in what is wrong with it. A
 * token is read from a file so it stays out of the process's arguments and
 * environment, which other processes can read; the file may end its line.
 */
export function readTokenFile(path: string, name: string): string {
  const token = readFileSync(path, "utf8").trimEnd();
  if (token.length === 0 || token !== token.trim()) {
    throw new Error(
      `${name} must be non-empty, with no surrounding whitespace`,
    );
  }
  return token;
}
