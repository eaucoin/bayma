---
name: bayma-platform-playwright
description: Inspect the source code of and execute code from the installed `playwright` npm package; drive a headless browser kept in this skill's folder.
---

# Playwright Platform

This skill shows you where to find the relevant packages to reference when writing correct source code or interactively executing code that interacts with the platform appropriately. The skill owns its packages and its browser; both live in its own folder, `<skill>` below.

## Reference Materials

The reference materials for this skill are the installed package source, type declarations, and package documentation under:

- `<skill>/node_modules/playwright/**`
- `<skill>/node_modules/playwright-core/**`

If these materials or the browser are missing, install them from the skill's lockfile, in a bayma Bun session whose `cwd` is `<skill>`:

```ts
await Bun.$`${process.execPath} install --frozen-lockfile 2>&1 && ${process.execPath} node_modules/playwright/cli.js install --only-shell chromium 2>&1`
  .env({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" })
  .nothrow()
  .text();
```

For Firefox or WebKit, install `firefox` or `webkit` in place of `--only-shell chromium`.

## Interactive Quickstart

In a bayma Bun session whose `cwd` is `<skill>`:

```ts
await (async () => {
  const skillDir = process.cwd();
  // The browser lives in the skill's node_modules, where the install puts it.
  process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
  globalThis.pw = await import(Bun.resolveSync("playwright", skillDir));

  globalThis.pwBrowser = await globalThis.pw.chromium.launch();
  globalThis.pwPage = await globalThis.pwBrowser.newPage();

  return {
    ready: true,
    browser: `${globalThis.pwBrowser.browserType().name()} ${globalThis.pwBrowser.version()}`,
    replCwd: process.cwd(),
  };
})();
```

If it throws because `playwright` or its browser is missing, install them as above.
