// Bun's binding, as far as `sqlite.ts` uses it. Bun's own types are not on the
// packages' type roots: the product is typed against Node.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean; strict?: boolean });
    run(sql: string): unknown;
    close(throwOnError?: boolean): void;
  }
}
