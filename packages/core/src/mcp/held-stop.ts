import { sandboxSaved } from "../sandbox.ts";
import { report } from "../telemetry/record.ts";

/**
 * What a held stop asks of the server's sessions: to start nothing new while
 * it is held, and to go on as before once it is let go.
 */
export interface StopHolder {
  holdStop(reason: string): void;
  releaseStop(): void;
}

/**
 * A stop the server holds for a save of its sandbox, as a host that ends the
 * sandbox's pod gives it the time to (--stop-wait-ms): SIGTERM begins it, and
 * for up to that long the server takes no new exec and no new session, those
 * running or queued carrying on, for its host to save the sandbox whole, as it releases a
 * session, which ends the sandbox before the stop goes on. The save's own
 * hook catches the stop in what it saves, so a restore from it lets the stop
 * go, the server's old pod's and not the restored one's; a resume, after a
 * save that failed or left the sandbox running, goes on with it at once, as
 * does `sandbox-hook stop`, once the server runs on where it is asked while
 * the server is saved, and the wait's end. Going on is the server's
 * ordinary stop, which persists its sessions. A `sandbox-hook stop` asked
 * before SIGTERM, as a host asks it as it ends the pod itself, which saves
 * nothing first, has the SIGTERM that follows within the wait go on at once;
 * a restore or a resume spends it, as one asked before the save was the old pod's.
 */
export class HeldStop {
  private readonly waitMs: number;
  private readonly sessions: StopHolder;
  private readonly stop: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private held = false;
  /**
   * Until when a SIGTERM goes on at once, as a `sandbox-hook stop` before it asked, in ms
   * of the monotonic clock (performance.now()), which no change of the wall clock moves.
   */
  private armedUntil: number | undefined;

  /** A stop held for up to `waitMs`, none for 0, which `stop` goes on with. */
  constructor(waitMs: number, sessions: StopHolder, stop: () => void) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0)
      throw new Error(
        "the stop's wait must be a whole number of ms, 0 or more",
      );
    this.waitMs = waitMs;
    this.sessions = sessions;
    this.stop = stop;
  }

  /** Whether a stop is held now. */
  get holding(): boolean {
    return this.held;
  }

  /** SIGTERM: holds the stop for a save, or goes on with it at once where it waits for none. */
  begin(): void {
    if (this.held) return;
    const armed =
      this.armedUntil !== undefined && performance.now() <= this.armedUntil;
    this.armedUntil = undefined;
    if (armed) {
      report(
        "bayma: stopping at once, as sandbox-hook stop asked before SIGTERM",
      );
      this.stop();
      return;
    }
    if (this.waitMs === 0) {
      this.stop();
      return;
    }
    this.held = true;
    this.sessions.holdStop(
      `the server is stopping: it holds its stop for up to ${this.waitMs / 1000} s for a save of its sandbox, and takes no new session or exec meanwhile`,
    );
    report(
      `bayma: stopping, held for up to ${this.waitMs / 1000} s for a save of the sandbox; sandbox-hook stop goes on with it at once`,
    );
    this.timer = setTimeout(() => this.waited(), this.waitMs);
  }

  /**
   * The sandbox was restored from a save that caught the stop: it was the old pod's, and the
   * server runs on. A stop asked before SIGTERM was the old pod's too: the restored pod's
   * SIGTERM holds.
   */
  restored(): void {
    this.armedUntil = undefined;
    if (!this.held) return;
    this.clear();
    this.sessions.releaseStop();
    report(
      "bayma: the stop held as the sandbox was saved was its old pod's; the restored server runs on",
    );
  }

  /**
   * The server runs on after a save, which failed or left the sandbox running: the stop goes
   * on. A stop asked before SIGTERM, before the save, is spent: a SIGTERM after it holds.
   */
  resumed(): void {
    this.armedUntil = undefined;
    if (this.held) this.goOn("the sandbox was not saved whole");
  }

  /**
   * Goes on with the held stop at once, saying why, as `sandbox-hook stop`
   * asks; with no stop held, has the next SIGTERM within the wait go on at
   * once, as one that asks before SIGTERM means.
   */
  goOn(reason: string): void {
    if (!this.held) {
      if (this.waitMs > 0) this.armedUntil = performance.now() + this.waitMs;
      return;
    }
    this.clear();
    report(`bayma: the held stop goes on, as ${reason}`);
    this.stop();
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.held = false;
  }

  /** The wait ended: the stop goes on, unless a save is under way, whose outcome decides. */
  private waited(): void {
    this.timer = undefined;
    if (!this.held || sandboxSaved()) return;
    this.goOn(`no save of the sandbox came within ${this.waitMs / 1000} s`);
  }
}
