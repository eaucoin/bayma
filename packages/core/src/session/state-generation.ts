import { Buffer } from "node:buffer";
import {
  closeSync,
  constants,
  fdatasyncSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SandboxSave } from "./model.ts";

/**
 * The state directory's generation: a count, on the disk, of the changes the
 * server persists or tells its clients of as state, which the session manager
 * moves on (bump) before either. It is the contract by which a host that
 * saves the sandbox live, leaving it running, knows whether that save may
 * still be restored: only while the generation on the disk is the one the
 * save caught (`sandbox-hook save` says it), as nothing has changed since.
 * Restored later, the sandbox would show its clients a state they had moved
 * past, and run again what they saw end.
 *
 * The file, `generation.json` in the state directory, is JSON
 * `{ "schemaVersion": 1, "generation": <count> }`, padded with spaces to a
 * size of its own, and rewritten in place, so that each bump is one write of
 * less than a sector, and a sync of the file alone.
 */
export const STATE_GENERATION_FILE = "generation.json";
/**
 * Where the server says what its last save caught (SandboxSave), as
 * `{ "schemaVersion": 1, "generation", "running" }`: for a host that saves the
 * sandbox, as it cannot read what `sandbox-hook save` printed in it.
 */
export const LAST_SAVE_FILE = "last-save.json";
export const STATE_GENERATION_SCHEMA_VERSION = 1 as const;

/** The size of the file, a write of which no disk tears. */
const FILE_BYTES = 128;

const StateGenerationSchema = z
  .object({
    schemaVersion: z.literal(STATE_GENERATION_SCHEMA_VERSION),
    generation: z.number().int().nonnegative(),
  })
  .strict();

/**
 * How what the server writes here reaches the disk: a file's data, and a
 * directory's entries.
 */
export interface StateGenerationSyncs {
  file: (fd: number) => void;
  directory: (fd: number) => void;
}

const SYNCS: StateGenerationSyncs = {
  file: fdatasyncSync,
  directory: fsyncSync,
};

/** The generation `text`, a generation file's, says. */
function parseGeneration(text: string): number {
  return StateGenerationSchema.parse(JSON.parse(text)).generation;
}

/** The generation of the state directory at `rootDir`, as the file says. */
export function readStateGeneration(rootDir: string): number {
  return parseGeneration(
    readFileSync(join(rootDir, STATE_GENERATION_FILE), "utf8"),
  );
}

/**
 * Syncs the directory `path`. A filesystem that cannot sync a directory says
 * so with EINVAL, borne alone: its entries are then as durable as that
 * filesystem makes any.
 */
function syncDirectory(path: string, syncs: StateGenerationSyncs): void {
  const directory = openSync(path, constants.O_RDONLY);
  try {
    syncs.directory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
  } finally {
    closeSync(directory);
  }
}

/**
 * The state generation could not be moved on (StateGeneration.bump): stale,
 * or the disk failed. The change it would have counted must not be told.
 */
export class StateGenerationNotMoved extends Error {
  override readonly name = "StateGenerationNotMoved";
}

export class StateGeneration {
  readonly path: string;
  private readonly rootDir: string;
  private readonly syncs: StateGenerationSyncs;
  private fd: number | undefined;
  private value = 0;
  /**
   * Why the generation on the disk is no longer this server's to move on, once
   * it is not.
   */
  private staleBecause: string | undefined;

  constructor(rootDir: string, syncs: StateGenerationSyncs = SYNCS) {
    this.rootDir = rootDir;
    this.path = join(rootDir, STATE_GENERATION_FILE);
    this.syncs = syncs;
  }

  /** The generation as of the last bump: the one on the disk. */
  get current(): number {
    return this.value;
  }

  /**
   * Opens the file, as the first bump does unless it is opened before, making
   * it, its directory's entry for it synced, where there is none. A file of
   * another schema, or none JSON, is refused: its generation cannot be told,
   * so neither can a bump.
   */
  open(): void {
    if (this.fd !== undefined) return;
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDWR);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.fd = openSync(
        this.path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      this.write(0);
      syncDirectory(this.rootDir, this.syncs);
      return;
    }
    try {
      this.value = parseGeneration(this.readFile(fd));
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.fd = fd;
  }

  /**
   * Moves the generation on, on the disk once this returns: before the change
   * it counts is persisted or told. It is moved on from the one on the disk,
   * which must be this server's last: one another wrote since, as a sandbox
   * saved live that ran on wrote before this one was restored from its save,
   * makes this server's generation stale, and this bump, and every later
   * one, throws. A write or a sync that fails throws too, and leaves the
   * generation where it was. Either way it throws StateGenerationNotMoved,
   * and the change must not be told.
   */
  bump(): number {
    this.assertCurrent();
    try {
      this.write(this.value + 1);
    } catch (error) {
      throw new StateGenerationNotMoved(
        `the state generation could not be moved on: ${(error as Error).message}`,
        { cause: error },
      );
    }
    return this.value;
  }

  /**
   * Throws StateGenerationNotMoved unless the generation on the disk is this
   * server's last, as bump does before it moves it on: for what writes into
   * the state directory without moving it on, as a save's last-save.json.
   */
  assertCurrent(): void {
    if (this.staleBecause !== undefined)
      throw new StateGenerationNotMoved(
        `the state generation is stale: ${this.staleBecause}`,
      );
    let onDisk: number;
    try {
      this.open();
      onDisk = parseGeneration(this.readFile(this.fd!));
    } catch (error) {
      throw new StateGenerationNotMoved(
        `the state generation could not be read: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (onDisk !== this.value) {
      this.staleBecause = `the state directory's generation is ${onDisk} on the disk, where this server last wrote ${this.value}`;
      throw new StateGenerationNotMoved(
        `the state generation is stale: ${this.staleBecause}`,
      );
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    closeSync(this.fd);
    this.fd = undefined;
  }

  /** What the open file `fd` holds, whole. */
  private readFile(fd: number): string {
    const bytes = Buffer.alloc(FILE_BYTES + 1);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.toString("utf8", 0, read);
  }

  private write(generation: number): void {
    if (this.fd === undefined)
      throw new Error("the state generation is not open");
    const text = JSON.stringify({
      schemaVersion: STATE_GENERATION_SCHEMA_VERSION,
      generation,
    });
    const bytes = Buffer.alloc(FILE_BYTES, " ");
    bytes.write(text, "utf8");
    bytes.write("\n", FILE_BYTES - 1, "utf8");
    if (writeSync(this.fd, bytes, 0, FILE_BYTES, 0) !== FILE_BYTES)
      throw new Error(`${this.path} was written short`);
    this.syncs.file(this.fd);
    this.value = generation;
  }
}

/**
 * Writes what the save of the sandbox caught where a host reads it, whole,
 * the file and its directory synced: a host reads it once the save it took
 * is on its own disk.
 */
export function writeLastSave(
  rootDir: string,
  caught: SandboxSave,
  syncs: StateGenerationSyncs = SYNCS,
): void {
  const path = join(rootDir, LAST_SAVE_FILE);
  const temporary = `${path}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    0o600,
  );
  try {
    const text =
      JSON.stringify({
        schemaVersion: STATE_GENERATION_SCHEMA_VERSION,
        ...caught,
      }) + "\n";
    writeSync(fd, text);
    syncs.file(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  syncDirectory(rootDir, syncs);
}
