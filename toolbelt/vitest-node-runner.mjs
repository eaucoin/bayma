import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

process.stdin.setEncoding("utf8");
let serializedRequest = "";
for await (const chunk of process.stdin) serializedRequest += chunk;
const request = JSON.parse(serializedRequest);
const root = resolve(request.options.root);
const projectRequire = createRequire(join(root, "package.json"));
const vitestEntry = projectRequire.resolve("vitest/node");
const { startVitest } = await import(pathToFileURL(vitestEntry).href);

const context = await startVitest(
  request.mode,
  request.filters,
  {
    ...request.options,
    outputFile: request.outputFile,
    reporters: ["json"],
    root,
    run: true,
    watch: false,
  },
  request.viteOverrides,
  request.vitestOptions,
);

if (context === undefined) {
  throw new Error("Vitest did not create a test context.");
}

await context.close();
