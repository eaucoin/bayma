import type { ProcessSnapshot } from "./process-snapshots.ts";

export interface TransportSessionHandle {
  sessionId: string;
  platformId: string;
  pid: number;
  cols: number;
  rows: number;
}

export interface StartSessionInput {
  sessionId: string;
  cwd: string;
  title: string;
  cols: number;
  rows: number;
  /**
   * The session's own scratch directory, which lives as long as the session
   * does, across its runtimes and snapshots: its temporary directory, and
   * where a runtime keeps what it builds.
   */
  scratchDir: string;
}

export type TransportChunkListener = (chunk: Uint8Array) => void;
export type TransportExitListener = (error: Error) => void;

/**
 * Snapshots of a transport's runtime processes: a live session's process
 * tree dumped whole, and restored as a live session again, ready for its next
 * exec, with no startup prompt of its own.
 */
export interface TransportSnapshots {
  /** Dump the session's process tree into `directory`, which ends it. */
  snapshot(
    handle: TransportSessionHandle,
    directory: string,
  ): Promise<ProcessSnapshot>;
  restore(
    input: StartSessionInput,
    snapshot: ProcessSnapshot,
    directory: string,
  ): Promise<TransportSessionHandle>;
  /** Why `snapshot` cannot be restored here, or undefined if it can. */
  unrestorableReason(snapshot: ProcessSnapshot): string | undefined;
}

export interface RuntimeTransport {
  startSession(input: StartSessionInput): Promise<TransportSessionHandle>;
  write(
    handle: TransportSessionHandle,
    data: Uint8Array | string,
  ): Promise<void>;
  resize(
    handle: TransportSessionHandle,
    size: { cols: number; rows: number },
  ): Promise<void>;
  subscribe(
    handle: TransportSessionHandle,
    onChunk: TransportChunkListener,
    onExit?: TransportExitListener,
  ): Promise<() => void>;
  waitForInitialPrompt(
    handle: TransportSessionHandle,
    timeoutMs?: number,
  ): Promise<void>;
  interrupt(
    handle: TransportSessionHandle,
    timeoutMs?: number,
  ): Promise<"soft" | "recycle">;
  terminate(handle: TransportSessionHandle): Promise<void>;
  shutdown(): Promise<void>;
  /** Absent where this transport's runtime processes cannot be snapshotted. */
  readonly snapshots?: TransportSnapshots;
}
