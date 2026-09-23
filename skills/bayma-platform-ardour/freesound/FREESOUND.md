# Freesound

Sounds and samples from [Freesound](https://freesound.org), through its API, with authorization kept in this folder, `<freesound>` below.

## Reference Materials

- `<freesound>/freesound.ts`: `search`, `sound`, `download`, and `api` for any other [API resource](https://freesound.org/docs/api/resources_apiv2.html)
- `<freesound>/auth.ts`: the authorization

Download sounds one at a time, as the work needs them: Freesound's terms allow copies of its sounds only as needed. `download` keeps each one's credit in `CREDITS.md` beside it, as its license asks.

## Interactive Quickstart

In a bayma Bun session whose `cwd` is `<freesound>`:

```ts
await (async () => {
  globalThis.freesound = await import(`${process.cwd()}/freesound.ts`);
  const [found] = await globalThis.freesound.search("thunder", {
    filter: 'license:"Creative Commons 0"',
    pageSize: 1,
  });
  return { ready: true, found };
})();
```

If it throws, its message names the fix. `freesound.download(id, directory)` downloads a sound's original file into the project's `directory`.
