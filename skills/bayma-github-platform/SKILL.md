---
name: bayma-github-platform
description: Inspect the source code of and execute code from the installed `octokit` npm package; bootstrap authentication with credentials kept in this skill's folder.
---

# GitHub Platform

This skill shows you where to find the relevant packages to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns its packages and its GitHub authorization; both live in its own folder, `<skill>` below.

## Reference Materials

The reference materials for this skill are the installed package source, type declarations, and package documentation under:

- `<skill>/node_modules/octokit/**`
- `<skill>/node_modules/@octokit/*/**`

If these materials are missing, install them from the skill's lockfile, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install --frozen-lockfile 2>&1`
  .nothrow()
  .text();
```

## Interactive Quickstart

In a bayma Bun session whose `cwd` is `<skill>`:

```ts
await (async () => {
  const skillDir = process.cwd();
  const { authorizationNeeded, readGitHubToken } = await import(
    `${skillDir}/auth.ts`
  );
  const { Octokit } = await import(Bun.resolveSync("octokit", skillDir));

  globalThis.ghOctokit = new Octokit({
    auth: readGitHubToken(),
    userAgent: "bayma-github-platform",
    request: {
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  });

  globalThis.ghRequest = (route, parameters = {}) =>
    globalThis.ghOctokit.request(route, parameters);
  globalThis.ghGraphql = (query, variables = {}) =>
    globalThis.ghOctokit.graphql(query, variables);

  const { data } = await globalThis.ghOctokit.rest.users
    .getAuthenticated()
    .catch((error) => {
      throw error.status === 401
        ? authorizationNeeded("GitHub rejected the saved token")
        : error;
    });
  globalThis.ghViewer = data.login;

  return {
    ready: true,
    viewer: globalThis.ghViewer,
    replCwd: process.cwd(),
  };
})();
```

If it throws, its message names the fix, or `octokit` is missing: install it as above. The scopes requested are in `<skill>/auth.json`.
