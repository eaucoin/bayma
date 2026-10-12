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
 */
export function runningTimeout(
  callback: () => void,
  ms: number,
): RunningTimeout {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleared = false;
  const arm = () => {
    timer = setTimeout(() => {
      if (!saved) return callback();
      void saved.resumed.then(() => {
        if (!cleared) arm();
      });
    }, ms);
  };
  arm();
  return {
    clear: () => {
      cleared = true;
      clearTimeout(timer);
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
