// Shared loop primitives for the long-running commands (`argus index --watch`, `argus sync --watch`,
// `argus run`). These commands assume a flaky laptop — it sleeps and wakes, drops Wi-Fi, loses the
// network for stretches — so every wait is cancellable, every retry is bounded with jitter, and a
// crashing leg restarts instead of taking the process down. Nothing here ever busy-waits.
import type { Log } from "./dashboard-builder.ts";

/**
 * Resolve after `ms`, or earlier when `signal` aborts. Always resolves (never rejects) so callers
 * fall through to their own `signal.aborted` check and exit the loop cleanly. Clears the timer on
 * abort so a pending wait doesn't keep the process alive.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface BackoffOptions {
  /** Delay for the first retry. */
  baseMs?: number;
  /** Upper bound on any single delay — keeps a long offline stretch from growing without limit. */
  capMs?: number;
  /** Multiplier applied per consecutive failure. */
  factor?: number;
  /** Full-jitter fraction in [0,1]: the delay is scaled by 1 ± (jitter · random). */
  jitter?: number;
}

/**
 * Stateful exponential backoff with a cap and full jitter. `next()` returns the delay to wait before
 * the next attempt and advances the sequence; `reset()` returns it to the base after a success so the
 * next failure starts small again. Jitter spreads retries so many failing clients don't sync up.
 */
export class Backoff {
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly factor: number;
  private readonly jitter: number;
  private attempts = 0;

  constructor(opts: BackoffOptions = {}) {
    this.baseMs = opts.baseMs ?? 1_000;
    this.capMs = opts.capMs ?? 60_000;
    this.factor = opts.factor ?? 2;
    this.jitter = opts.jitter ?? 0.5;
  }

  next(): number {
    const exp = Math.min(this.capMs, this.baseMs * this.factor ** this.attempts);
    this.attempts++;
    const spread = 1 - this.jitter + Math.random() * this.jitter * 2;
    return Math.max(0, Math.round(exp * spread));
  }

  reset(): void {
    this.attempts = 0;
  }

  get attempt(): number {
    return this.attempts;
  }
}

/**
 * Logs a message only when it differs from the previous one, counting identical repeats silently and
 * emitting a "repeated N more times" summary when the state changes. Keeps an offline laptop that
 * fails the same way every retry from filling the supervisor's log.
 */
export class RepeatCollapser {
  private last: string | null = null;
  private repeats = 0;

  constructor(private readonly log: Log) {}

  /** Note a message. Logs (and returns true) only when it's new; otherwise counts it and returns false. */
  note(msg: string): boolean {
    if (msg === this.last) {
      this.repeats++;
      return false;
    }
    this.flush();
    this.log(msg);
    this.last = msg;
    return true;
  }

  /** Emit any suppressed-repeat summary and clear the run, so the next message always logs fresh. */
  flush(): void {
    if (this.repeats > 0) {
      this.log(`  (the previous message repeated ${this.repeats} more time${this.repeats === 1 ? "" : "s"})`);
      this.repeats = 0;
    }
    this.last = null;
  }
}

export interface SuperviseOptions {
  /** Aborting this signal asks the supervised loop to stop; `superviseLoop` then resolves. */
  signal: AbortSignal;
  log: Log;
  backoff?: BackoffOptions;
  /** Collapse runs of the identical failure into one line + a count, so an offline laptop that fails
   *  every attempt doesn't fill the log. Default true. */
  collapseRepeats?: boolean;
}

/**
 * Run `body` under supervision until `signal` aborts. `body` is expected to run its own inner loop
 * until the signal aborts; if it throws (a leg crashed) or returns early while still running, the
 * error is logged and the body is restarted after a bounded, jittered backoff. The backoff resets
 * once a restarted body survives to the next failure. Resolves cleanly on abort; never rethrows.
 */
export async function superviseLoop(
  name: string,
  body: (signal: AbortSignal) => Promise<void>,
  opts: SuperviseOptions,
): Promise<void> {
  const { signal, log } = opts;
  const backoff = new Backoff(opts.backoff);
  const collapse = opts.collapseRepeats ?? true;
  const collapser = new RepeatCollapser(log);

  while (!signal.aborted) {
    let msg: string;
    try {
      await body(signal);
      // A clean return is only expected on abort. If the body returns while still running, treat it
      // like a crash so the leg comes back rather than silently stopping.
      if (signal.aborted) break;
      msg = `! The ${name} loop stopped unexpectedly — restarting.`;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      msg = `! The ${name} loop hit an error: ${detail} — restarting.`;
    }
    // A new failure mode is a kind of progress: log it and restart the backoff. Identical repeats
    // stay quiet and keep stepping the backoff up toward the cap.
    const changed = collapse ? collapser.note(msg) : (log(msg), true);
    if (changed) backoff.reset();
    await sleep(backoff.next(), signal);
  }
  collapser.flush();
}
