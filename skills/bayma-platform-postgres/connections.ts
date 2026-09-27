// PostgreSQL connections for this skill, kept in this skill's folder. Each is
// a name and a connection string, saved in .connections/NAME.json, readable
// only by you.
//
//   bun connections.ts                   list the saved connections
//   bun connections.ts add NAME URL      connect to URL and save it as NAME;
//                                        asks for the password URL leaves out
//   bun connections.ts remove NAME       forget NAME
//
// URL is postgresql://USER@HOST:PORT/DATABASE, with TLS in its query, such as
// ?sslmode=verify-full&sslrootcert=/path/to/ca.pem. It names the host, user,
// and database itself, so nothing is filled in from PG* variables or
// ~/.pgpass: a connection is exactly what was saved.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface SavedConnection {
  url: string;
}

const SAVED = join(import.meta.dir, ".connections");
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** An error that ends with the one command that fixes it. */
export function connectionNeeded(reason: string): Error {
  return new Error(
    `${reason}. Save a connection: ${process.execPath} ${join(import.meta.dir, "connections.ts")} add NAME postgresql://USER@HOST:PORT/DATABASE`,
  );
}

/** The names of the saved connections. */
export function listConnections(): string[] {
  if (!existsSync(SAVED)) return [];
  return readdirSync(SAVED)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/**
 * A saved connection, `{ name, url }`: the one named, or with no name, the
 * only one saved.
 */
export function readConnection(name?: string): { name: string; url: string } {
  const names = listConnections();
  if (name === undefined) {
    if (names.length === 0)
      throw connectionNeeded("This skill has no saved connections");
    if (names.length > 1)
      throw new Error(
        `This skill has several saved connections; name one: ${names.join(", ")}`,
      );
    name = names[0]!;
  }
  if (!names.includes(name))
    throw connectionNeeded(
      `This skill has no connection named ${name}${names.length > 0 ? ` (it has ${names.join(", ")})` : ""}`,
    );
  const saved = JSON.parse(
    readFileSync(join(SAVED, `${name}.json`), "utf8"),
  ) as SavedConnection;
  return { name, url: saved.url };
}

/** URL with its password, if any, hidden. */
function redacted(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "****";
  return parsed.toString();
}

/** A line from the terminal, not echoed; or from stdin when it is not one. */
async function askPassword(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const text = await new Response(Bun.stdin.stream()).text();
    return text.split("\n")[0] ?? "";
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    let line = "";
    for await (const chunk of stdin) {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return line;
        if (char === "\u0003") throw new Error("Cancelled");
        if (char === "\u007f") line = line.slice(0, -1);
        else line += char;
      }
    }
    return line;
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
}

/** Connects to URL, then saves it as NAME. */
export async function add(name: string, url: string): Promise<void> {
  if (!NAME.test(name))
    throw new Error(
      `A connection name is letters, digits, "-", and "_": ${name}`,
    );
  const parsed = new URL(url);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:")
    throw new Error(`Not a postgresql:// URL: ${redacted(url)}`);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!parsed.hostname || !parsed.username || !database)
    throw new Error(
      `The URL names no ${[!parsed.hostname && "host", !parsed.username && "user", !database && "database"].filter(Boolean).join(", ")}: ${redacted(url)}`,
    );
  if (!parsed.password) {
    const password = await askPassword(
      `Password for ${decodeURIComponent(parsed.username)} (empty for none): `,
    );
    if (password) parsed.password = encodeURIComponent(password);
  }
  url = parsed.toString();

  // Imported here, not above: reading a connection does not need pg, so a
  // REPL session that imported this file before pg was installed can still
  // use it once pg is.
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: url,
    application_name: "bayma-platform-postgres",
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ version: string }>(
      "select current_setting('server_version') as version",
    );
    console.log(
      `Connected to PostgreSQL ${rows[0]!.version} at ${redacted(url)}`,
    );
  } finally {
    await client.end();
  }

  mkdirSync(SAVED, { recursive: true, mode: 0o700 });
  chmodSync(SAVED, 0o700);
  const path = join(SAVED, `${name}.json`);
  writeFileSync(path, JSON.stringify({ url }, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
  console.log(`Saved as ${name}`);
}

/** Forgets NAME. */
export function remove(name: string): void {
  if (!listConnections().includes(name))
    throw new Error(`This skill has no connection named ${name}`);
  rmSync(join(SAVED, `${name}.json`));
  console.log(`Removed ${name}`);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === undefined) {
      const names = listConnections();
      if (names.length === 0) console.log("No saved connections");
      for (const name of names)
        console.log(`${name}\t${redacted(readConnection(name).url)}`);
    } else if (command === "add" && rest.length === 2) {
      await add(rest[0]!, rest[1]!);
    } else if (command === "remove" && rest.length === 1) {
      remove(rest[0]!);
    } else {
      console.error("Usage: bun connections.ts [add NAME URL | remove NAME]");
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
