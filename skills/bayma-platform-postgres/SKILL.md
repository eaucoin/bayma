---
name: bayma-platform-postgres
description: Inspect the source code of and execute code from the installed `pg` npm package, node-postgres; connect to PostgreSQL servers with connections kept in this skill's folder.
---

# PostgreSQL Platform

This skill shows you where to find the relevant packages to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns its packages and its connections to PostgreSQL servers; both live in its own folder, `<skill>` below. The servers themselves run wherever they run.

## Reference Materials

The reference materials for this skill are the installed package source, type declarations, and package documentation under:

- `<skill>/node_modules/pg/**`: `Client`, `Pool`, and queries
- `<skill>/node_modules/pg-pool/**`, `pg-protocol/**`, `pg-types/**`, and `pg-connection-string/**`: the pool, the wire protocol, how values are parsed, and connection strings
- https://node-postgres.com: node-postgres's documentation
- https://www.postgresql.org/docs/current/: PostgreSQL's SQL and server

If these materials are missing, install them from the skill's lockfile, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install --frozen-lockfile 2>&1`
  .nothrow()
  .text();
```

## Connections

Each connection is a name and a `postgresql://USER@HOST:PORT/DATABASE` URL, with TLS in its query, such as `?sslmode=verify-full&sslrootcert=/path/to/ca.pem`. Saving one connects to it first and asks, without echoing, for the password the URL leaves out, so it stays out of shell and REPL session history. In a terminal, in `<skill>`:

```sh
bun connections.ts add NAME URL   # connect to URL and save it as NAME
bun connections.ts                # list the saved connections
bun connections.ts remove NAME    # forget NAME
```

## Interactive Quickstart

In a bayma Bun session whose `cwd` is `<skill>`:

```ts
await (async () => {
  const skillDir = process.cwd();
  const { connectionNeeded, readConnection } = await import(
    `${skillDir}/connections.ts`
  );
  const { default: pg } = await import(Bun.resolveSync("pg", skillDir));

  // The only saved connection; name one when there are several.
  const connection = readConnection();

  await globalThis.pgPool?.end();
  globalThis.pgPool = new pg.Pool({
    connectionString: connection.url,
    application_name: "bayma-platform-postgres",
    max: 4,
  });
  // Connections close under an idle pool, as they do when bayma restores a
  // REPL session; the pool opens new ones for the next query.
  globalThis.pgPool.on("error", () => {});

  globalThis.pgQuery = (text, values) => globalThis.pgPool.query(text, values);
  globalThis.pgTransaction = async (body) => {
    const client = await globalThis.pgPool.connect();
    try {
      await client.query("begin");
      const result = await body(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };

  const { rows } = await globalThis
    .pgQuery(
      "select current_setting('server_version') as server, current_database() as database, current_user as user",
    )
    .catch((error) => {
      throw error.code === "28P01"
        ? connectionNeeded(
            `The server rejected the saved password for ${connection.name}`,
          )
        : error;
    });

  return {
    ready: true,
    connection: connection.name,
    ...rows[0],
    replCwd: process.cwd(),
  };
})();
```

If it throws, its message names the fix, or `pg` is missing: install it as above. `pgQuery(text, values)` runs one statement with `$1`-style parameters; `pgTransaction(async (client) => ...)` runs several on one connection and commits them together.
