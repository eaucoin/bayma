// The sandbox bayma runs in, as a host that saves it whole and restores it,
// maybe much later and elsewhere, runs it: from the save until the restore,
// or the resume, the server is saved (mcp/sandbox-hook.ts hears when). A
// restore moves the clocks on by however long the sandbox stayed saved, and
// the restored server runs on before it hears of the restore, so a timeout
// armed before the save would end at once, measuring time the server never
// ran. A timeout armed here instead starts again, whole, when it would end
// while the server is saved, once the server resumes.

interface Saved {
  resumed: Promise<void>;
  resume: () => void;
}

let saved: Saved | undefined;

/** The server is about to be saved, with the sandbox it runs in. */
export function markSandboxSaved(): void {
  if (saved) return;
  let resume = () => {};
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  saved = { resumed, resume };
}

/** The server runs on: restored, or never saved after all. */
export function markSandboxResumed(): void {
  const resuming = saved;
  saved = undefined;
  resuming?.resume();
}

// How many pieces of work that hold files open run now (holdingFiles), and
// who waits for none to (filesClosed).
let holding = 0;
const closing: (() => void)[] = [];

/**
 * Runs `work`, which holds files open while it runs, once the server is not
 * saved. A save waits for any that runs to end (filesClosed), and none starts
 * while the server is saved: a host restores a sandbox only where each file it
 * held open is as it was, and one saved live runs on, its files with it, so
 * a save that caught a file open could not be restored once that file moved
 * on.
 */
export async function holdingFiles<T>(work: () => Promise<T>): Promise<T> {
  while (saved) await saved.resumed;
  holding += 1;
  try {
    return await work();
  } finally {
    holding -= 1;
    if (holding === 0) for (const closed of closing.splice(0)) closed();
  }
}

/** Settles once no work that holds files open runs (holdingFiles). */
export function filesClosed(): Promise<void> {
  if (holding === 0) return Promise.resolve();
  return new Promise((resolve) => closing.push(resolve));
}

/**
 * The save a sandbox was restored from is one its state directory has moved
 * on from (../session/state-generation.ts): the restored server must not run
 * on, writing over what is newer.
 */
export class SandboxSaveOutlived extends Error {
  override readonly name = "SandboxSaveOutlived";
}

/** Settles once the server runs on: at once while it is not saved. */
export function sandboxRunsOn(): Promise<void> {
  return saved?.resumed ?? Promise.resolve();
}

/** Whether the server is saved, between a save and its restore or resume. */
export function sandboxSaved(): boolean {
  return saved !== undefined;
}

/** A timeout armed with `runningTimeout`, which `clear` disarms. */
export interface RunningTimeout {
  clear: () => void;
}

/**
 * Calls `callback` once `ms` have passed, as `setTimeout` does, unless that
 * is while the server is saved: then `ms` starts again once it resumes.
 *
 * And only once the server has read what came by then, which may have been
 * what would have cleared it. A timer's time is the clock's, which runs on
 * while the server does not, as a restored server waits for its pages, and
 * Node runs the timers that came due meanwhile before it reads what came: so
 * the callback waits for the poll that follows, which reads it, and is not
 * called where that cleared the timeout. Checking what the socket holds would
 * not do: what came is still the kernel's then, not the stream's. A
 * connection that came meanwhile is only read in the poll after that, so a
 * request on one does not.
 */
export function runningTimeout(
  callback: () => void,
  ms: number,
): RunningTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let after: ReturnType<typeof setImmediate> | undefined;
  let cleared = false;
  const arm = () => {
    timer = setTimeout(() => {
      if (saved) {
        void saved.resumed.then(() => {
          if (!cleared) arm();
        });
        return;
      }
      after = setImmediate(() => {
        if (!cleared) callback();
      });
    }, ms);
  };
  arm();
  return {
    clear: () => {
      cleared = true;
      clearTimeout(timer);
      clearImmediate(after);
    },
  };
}

/** Settles once `ms` have passed as `runningTimeout` counts them. */
export function sleepRunning(ms: number): Promise<void> {
  return new Promise((resolve) => runningTimeout(resolve, ms));
}

/**
 * Whether the server, saved, resumes within `ms` of the time it runs: true
 * at once when it is not saved. The time is counted a second at a time,
 * which a restore's jump of the clocks moves on by a second at most.
 */
export function resumesWithin(ms: number): Promise<boolean> {
  const waiting = saved;
  if (!waiting) return Promise.resolve(true);
  return new Promise((resolve) => {
    let seconds = 0;
    const ticker = setInterval(() => {
      seconds += 1;
      if (seconds * 1000 < ms) return;
      clearInterval(ticker);
      resolve(false);
    }, 1000);
    void waiting.resumed.then(() => {
      clearInterval(ticker);
      resolve(true);
    });
  });
}
