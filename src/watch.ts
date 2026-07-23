// The long-running loops behind `argus index --watch`, `argus sync --watch`, and the legs of
// `argus run`. Each takes an AbortSignal so the caller owns shutdown, and each is built on the
// backoff primitives so a flaky laptop (sleep/wake, dropped Wi-Fi) never busy-waits or floods logs.
import { Backoff, RepeatCollapser, sleep, superviseLoop } from "./backoff.ts";
import { HUB_SETTINGS, loadConfig, resolveSetting } from "./config.ts";
import { type BuildDashboardOptions, sourcesFor } from "./reporting/dashboard-builder.ts";
import { runIndex } from "./index-ops.ts";
import { STORE_FILE } from "./paths.ts";
import { hubErrorMessage, pushHubJson, type PushResult } from "./push.ts";
import { resolveHubConfig } from "./secrets.ts";
import { openStore } from "./store/store.ts";
import type { SyncOptions } from "./cli-options.ts";
import { logError, type Log } from "./logger.ts";

const MIN_INTERVAL_MIN = 1;
const DEFAULT_CONFIG_CHECK_INTERVAL_MS = 5_000;

export interface WatchIndexOptions extends SyncOptions {
  /** Minutes between reads. */
  intervalMin: number;
  /** Tri-state `--extract-tasks` override threaded to each pass (undefined = defer to argus.json). */
  extractTasks?: boolean;
  /** Tri-state `--retain-text` override threaded to each pass (undefined = defer to argus.json/env, #120). */
  retainText?: boolean;
}

/** Test seam: override the one-shot index pass (defaults to the real `runIndex`). */
export interface WatchIndexDeps {
  index?: (
    opts: SyncOptions,
    log: Log,
    extractTasks?: boolean,
    debug?: boolean,
    retainText?: boolean,
    interpretCollapser?: RepeatCollapser,
  ) => Promise<void>;
}

/**
 * Keep the local store current: index once immediately, then every `intervalMin` minutes until the
 * signal aborts. Wrapped in `superviseLoop` so an unexpected error mid-read restarts the loop with
 * backoff instead of stopping it. Indexing is the only writer to the store.
 */
export async function watchIndex(opts: WatchIndexOptions, log: Log, signal: AbortSignal, deps: WatchIndexDeps = {}): Promise<void> {
  const indexPass = deps.index ?? runIndex;
  const intervalMs = Math.max(MIN_INTERVAL_MIN, opts.intervalMin) * 60_000;
  // One collapser for the whole watch lifetime so the interpretation drain's throttle-pause / failure
  // lines (#153) are said once and not repeated every tick while the situation persists.
  const interpretCollapser = new RepeatCollapser(log);
  await superviseLoop(
    "indexing",
    async (sig) => {
      while (!sig.aborted) {
        await indexPass(opts, log, opts.extractTasks, false, opts.retainText, interpretCollapser);
        await sleep(intervalMs, sig);
      }
    },
    { signal, log },
  );
}

export interface PushLoopOptions extends BuildDashboardOptions {
  /** Hub mode only: skip local cursor filtering and re-upload every session. */
  all?: boolean;
}

export interface WatchSyncOptions extends PushLoopOptions {
  /** Minutes between uploads. */
  intervalMin: number;
  /** How often to check for Hub settings when the process started without a configured Hub. */
  configCheckIntervalMs?: number;
}

/** POST session data to Argus Hub. Returns a non-ok result when Hub is not configured. */
export async function pushSnapshotForOpts(opts: PushLoopOptions, log: Log): Promise<PushResult> {
  // Check source eligibility before any hub config lookup — local-only sources are never uploaded.
  if (sourcesFor(opts.source, { forWire: true }).length === 0) {
    return {
      ok: true,
      skipped: true,
      status: 0,
      body: `Nothing to upload: "${opts.source}" is a local-only source, not synced to Hub.`,
    };
  }
  const hubCfg = await resolveHubConfig({ log });
  if (!hubCfg) {
    return {
      ok: false,
      status: 0,
      notConfigured: true,
      body: "No Hub configured. Set ARGUS_HUB_URL and ARGUS_HUB_KEY to upload usage data.",
    };
  }
  log(`Uploading to Hub → ${hubCfg.url}`);
  const store = await openStore({ path: STORE_FILE });
  await store.close();
  return pushHubJson(hubCfg.url, hubCfg.key, STORE_FILE, {
    all: opts.all,
    log,
    source: opts.source,
    since: opts.since,
    until: opts.until,
    project: opts.project,
  });
}

/** Test seam: override the upload (defaults to the real implementation). */
export interface WatchSyncDeps {
  push?: (opts: PushLoopOptions, log: Log) => Promise<PushResult>;
}

/** The Hub URL as currently configured (managed > env > argus.json), read fresh so a settings
 *  change made while the loop runs is visible. Never touches the keychain. */
function currentHubUrl(): string | undefined {
  return resolveSetting(HUB_SETTINGS.url, {}, loadConfig());
}

/** Wait until the configured Hub URL differs from `url` (the one the failed attempt used), or the
 *  signal aborts. Polling settings lets a fatal upload failure recover when the user points at a
 *  different Hub, without restarting the process. */
async function waitForHubUrlChange(url: string | undefined, intervalMs: number, signal: AbortSignal): Promise<void> {
  while (!signal.aborted && currentHubUrl() === url) {
    await sleep(intervalMs, signal);
  }
}

/**
 * Periodically upload the snapshot until the signal aborts. Transient failures (offline, DNS,
 * connection refused, 5xx) back off with jitter and re-resolve settings on each attempt; a
 * success resets the backoff and resumes the normal interval. Repeated identical failures
 * collapse to one log line. A fatal failure (schema mismatch, a local store error) stops
 * retrying until the configured Hub URL changes, so pointing at a different Hub takes effect
 * without a restart.
 */
export async function watchSync(opts: WatchSyncOptions, log: Log, signal: AbortSignal, deps: WatchSyncDeps = {}): Promise<void> {
  const push = deps.push ?? pushSnapshotForOpts;
  const intervalMs = Math.max(MIN_INTERVAL_MIN, opts.intervalMin) * 60_000;
  const configCheckIntervalMs = opts.configCheckIntervalMs ?? DEFAULT_CONFIG_CHECK_INTERVAL_MS;

  const backoff = new Backoff();
  const collapser = new RepeatCollapser(log);

  await superviseLoop(
    "upload",
    async (sig) => {
      while (!sig.aborted) {
        // Snapshot the URL this attempt runs against, so a fatal failure below holds until the
        // user changes it — not until some unrelated future edit.
        const attemptUrl = currentHubUrl();
        let res: PushResult;
        try {
          res = await push(opts, log);
        } catch (err) {
          // Network error — the normal case on a laptop that drops off Wi-Fi. Back off quietly.
          collapser.note(`Upload failed: ${err instanceof Error ? err.message : String(err)}. Retrying.`, "warn");
          await sleep(backoff.next(), sig);
          continue;
        }
        // A failure that won't heal by retrying against the same Hub. Log it once, then hold
        // until the Hub URL changes in settings and try again with the new URL.
        const holdForNewHubUrl = async (message: string) => {
          logError(log, message);
          await waitForHubUrlChange(attemptUrl, configCheckIntervalMs, sig);
          if (sig.aborted) return;
          collapser.flush();
          backoff.reset();
          log("The Hub URL changed. Trying the upload again.");
        };
        if (res.skipped) {
          // Nothing eligible to upload. Not an error: idle a normal interval.
          collapser.note(res.body);
          backoff.reset();
          await sleep(intervalMs, sig);
        } else if (res.ok) {
          collapser.flush();
          log(`Uploaded (${res.status}).`);
          backoff.reset();
          await sleep(intervalMs, sig);
        } else if (res.status === 422) {
          // Schema version mismatch: permanent until one side is upgraded. The Hub's body states
          // the direction (client too new → update the Hub; too old → re-index).
          await holdForNewHubUrl(`Hub rejected upload (422): ${hubErrorMessage(res.body)}`);
        } else if (res.notConfigured) {
          // The desktop shell starts the sync loop even before a Hub is configured. Keep checking so
          // adding the URL/key in Settings takes effect without restarting the sidecar.
          collapser.note(res.body);
          backoff.reset();
          await sleep(configCheckIntervalMs, sig);
        } else if (res.network) {
          // Couldn't reach the Hub — the flaky-laptop case (offline, DNS, refused), or a bad URL.
          // Back off and retry; each attempt re-resolves settings, so a corrected URL is picked up.
          collapser.note(`Upload failed: ${res.body}. Retrying.`, "warn");
          await sleep(backoff.next(), sig);
        } else if (res.status === 0) {
          // status 0 without `network` = a local error (e.g. the store couldn't be read). Retrying
          // won't help; hold like the 422 case.
          await holdForNewHubUrl(res.body);
        } else {
          collapser.note(`Upload failed (${res.status}). Retrying.`, "warn");
          await sleep(backoff.next(), sig);
        }
      }
    },
    { signal, log },
  );
}
