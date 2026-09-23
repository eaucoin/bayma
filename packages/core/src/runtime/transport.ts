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
}

export type TransportChunkListener = (chunk: Uint8Array) => void;
export type TransportExitListener = (error: Error) => void;

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
}
