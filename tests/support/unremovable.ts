import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * A tree in `parent` shaped as Go's module cache leaves one: its directories
 * 0555 and its files 0444, so that nothing in it can be unlinked as it is.
 * Returns its top, `parent`/go.
 */
export function goModuleCache(parent: string): string {
  const top = join(parent, "go");
  const module = join(top, "path", "pkg", "mod", "example.com", "m@v1.0.0");
  mkdirSync(join(module, "sub"), { recursive: true });
  writeFileSync(join(module, "go.mod"), "module example.com/m\n");
  writeFileSync(join(module, "sub", "m.go"), "package sub\n");
  // Deepest first, each directory read-only once what it holds is.
  const paths: string[] = [];
  const walk = (path: string) => {
    paths.push(path);
    if (statSync(path).isDirectory())
      for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(top);
  for (const path of paths.reverse())
    chmodSync(path, statSync(path).isDirectory() ? 0o555 : 0o444);
  return top;
}

/**
 * Whether tests make what root owns: on CI's runners, whose user runs sudo
 * without a password; such a test fails there if sudo does not, rather than
 * passes unrun.
 */
export const AS_ROOT = process.env["CI"] === "true";

/**
 * Makes `path` a tree of empty directories root owns, `path`/a/b, of which
 * this test's user can remove nothing, as an old test left one in a session's
 * scratch on a box; returns its removal, which the test owes.
 */
export function rootOwned(path: string): () => void {
  for (const args of [["mkdir", "-p", join(path, "a", "b")]]) {
    const made = spawnSync("sudo", ["-n", ...args], { encoding: "utf8" });
    if (made.status !== 0)
      throw new Error(`sudo ${args.join(" ")} failed: ${made.stderr}`);
  }
  return () => {
    spawnSync("sudo", ["-n", "rm", "-rf", path]);
  };
}
