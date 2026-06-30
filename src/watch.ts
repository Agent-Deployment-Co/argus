// The long-running loops behind `argus index --watch`, `argus sync --watch`, and the legs of
// `argus run`. Each takes an AbortSignal so the caller owns shutdown, and each is built on the
// backoff primitives so a flaky laptop (sleep/wake, dropped Wi-Fi) never busy-waits or floods logs.
import { mkdirSync, watch as fsWatch } from "node:fs";
import { dirname, basename } from "node:path";
import {
  isLegacyAccessTokenCache,
  isManagedOAuthTokenCache,
  loadAccessTokenCache,
  oauthCacheMatchesEndpoint,
  oauthTokenIsFresh,
  refreshManagedOAuthToken,
  saveAccessTokenCache,
} from "./auth.ts";
import { Backoff, RepeatCollapser, sleep, superviseLoop } from "./backoff.ts";
import { buildDashboard, sourcesFor, summaryLine, type BuildDashboardOptions } from "./reporting/dashboard-builder.ts";
import { runIndex } from "./index-ops.ts";
import { ACCESS_TOKEN_FILE, STORE_FILE } from "./paths.ts";
import { detectOrg, detectUser, hubErrorMessage, pushHubJson, pushSnapshot, SCHEMA_VERSION, type PushCredentials, type PushResult } from "./push.ts";
import { resolveHubConfig, type ResolvedHubConfig } from "./secrets.ts";
import { openStore } from "./store/store.ts";
import type { SyncOptions } from "./cli-options.ts";
import { logError, logWarn, type Log } from "./logger.ts";

const MIN_INTERVAL_MIN = 1;

export interface WatchIndexOptions extends SyncOptions {
  /** Minutes between reads. */
  intervalMin: number;
  /** Tri-state `--extract-tasks` override threaded to each pass (undefined = defer to argus.json). */
  extractTasks?: boolean;
  /** Tri-state `--retain-text` override threaded to each pass (undefined = defer to argus.json/env, #120). */
  retainText?: boolean;
  /** Wakes the loop before the normal interval, e.g. after web Settings writes. */
  wakeSignal?: LoopWakeSignal;
}

export interface LoopWakeSignal {
  wait(timeoutMs: number | undefined, signal: AbortSignal): Promise<void>;
}

export interface LoopWakeController {
  signal: LoopWakeSignal;
  wake(): void;
}

/** A tiny in-process wake signal for supervised loops. It is edge-triggered: callers that are already
 *  sleeping wake immediately, and callers that start waiting after the wake just wait for the next one. */
export function createLoopWake(): LoopWakeController {
  const waiters = new Set<() => void>();
  const signal: LoopWakeSignal = {
    wait(timeoutMs, abortSignal) {
      if (abortSignal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          waiters.delete(done);
          abortSignal.removeEventListener("abort", done);
          resolve();
        };
        waiters.add(done);
        abortSignal.addEventListener("abort", done, { once: true });
        if (timeoutMs !== undefined) timer = setTimeout(done, timeoutMs);
      });
    },
  };
  return {
    signal,
    wake() {
      for (const waiter of [...waiters]) waiter();
    },
  };
}

function waitForNextLoop(intervalMs: number, signal: AbortSignal, wakeSignal?: LoopWakeSignal): Promise<void> {
  return wakeSignal ? wakeSignal.wait(intervalMs, signal) : sleep(intervalMs, signal);
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
        await waitForNextLoop(intervalMs, sig, opts.wakeSignal);
      }
    },
    { signal, log },
  );
}

export interface PushLoopOptions extends BuildDashboardOptions {
  endpoint: string;
  user?: string;
  org?: string;
  /** Hub mode only: skip local cursor filtering and re-upload every session. */
  all?: boolean;
}

export type OnUnauthenticated = "fail" | "dormant";

export interface WatchSyncOptions extends PushLoopOptions {
  /** Minutes between uploads. */
  intervalMin: number;
  /** What to do when there's no usable credential: standalone `sync --watch` fails fast at startup;
   *  the run-embedded leg stays dormant and recovers once the user logs in. */
  onUnauthenticated: OnUnauthenticated;
  /** Desktop mode: only upload when Argus Hub is configured; never fall back to Cloudflare Access. */
  hubOnly?: boolean;
  /** Wakes the loop before the normal interval, e.g. after web Settings writes. */
  wakeSignal?: LoopWakeSignal;
}

/**
 * Resolve push credentials the same way the one-shot upload does (CI client id/secret, else the
 * cached managed-OAuth token, refreshing it when stale, else a legacy cloudflared jwt). Returns null
 * instead of exiting when nothing usable is found, so the watch loops can decide what to do. Re-read
 * on every pass so a later `argus login` is picked up without a restart.
 */
export async function resolveCredentials(endpoint: string, log: Log): Promise<PushCredentials | null> {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  const credentials: PushCredentials = {};
  let cached = loadAccessTokenCache(ACCESS_TOKEN_FILE);
  if (isManagedOAuthTokenCache(cached) && oauthCacheMatchesEndpoint(cached, endpoint)) {
    if (!oauthTokenIsFresh(cached)) {
      log("Refreshing Cloudflare Access login…");
      try {
        cached = await refreshManagedOAuthToken(cached);
        saveAccessTokenCache(ACCESS_TOKEN_FILE, cached);
      } catch (err) {
        logWarn(log, `Login refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        cached = undefined;
      }
    }
    if (isManagedOAuthTokenCache(cached)) credentials.bearerToken = cached.accessToken;
  } else if (isLegacyAccessTokenCache(cached)) {
    // Preserve existing cloudflared caches during migration.
    credentials.jwt = cached.token;
  }

  if (!credentials.bearerToken && !credentials.jwt) return null;
  return credentials;
}

/** Build the current snapshot and POST it. Logs who/where, then returns the raw result so callers
 *  map success/challenge/error to their own behavior (exit codes for one-shot, backoff for watch).
 *  When hub.url + hub.key are configured, uploads the session data as JSON read from the local
 *  store instead of a Worker-aggregated snapshot; credentials are not used in that path. */
export async function pushSnapshotForOpts(opts: PushLoopOptions, credentials: PushCredentials, log: Log): Promise<PushResult> {
  const hubCfg = await resolveHubConfig({ log });
  if (hubCfg) {
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
  const user = detectUser(opts.user);
  const org = detectOrg(opts.org);
  // forWire: drop local-only sources (claude.ai chat) from the uploaded snapshot — it's personal
  // usage with estimated tokens, surfaced in the local web app only. If the requested source is
  // ENTIRELY local-only, there's nothing to upload — bail rather than fall through to the store's
  // empty-sources default (which is "claude"), which would silently upload Claude Code data instead.
  if (sourcesFor(opts.source, { forWire: true }).length === 0) {
    // The message rides on `body` (not logged here) so each caller surfaces it appropriately: the
    // one-shot logs it once; the --watch leg routes it through its collapser to avoid per-interval spam.
    return {
      ok: true,
      skipped: true,
      status: 0,
      body: `Nothing to upload: "${opts.source}" is a local-only source, not synced to the team dashboard.`,
    };
  }
  const dash = await buildDashboard({ ...opts, forWire: true }, log);
  log(`Uploading snapshot for "${user}" (org: ${org ?? "from token"}) → ${opts.endpoint}`);
  log(`  ${summaryLine(dash)}`);
  return pushSnapshot(opts.endpoint, credentials, {
    schemaVersion: SCHEMA_VERSION,
    org,
    user,
    generatedAtMs: dash.generatedAtMs,
    // Cast: the schema's AgentSource union lags the local one by one source ("cowork" pending
    // argus-schema update). The server will reject cowork sessions at runtime until then.
    dashboard: dash as any,
  });
}

/**
 * Wait until the token file changes on disk (written by `argus login`) or the signal aborts.
 * Falls back to a 15-minute timeout in case the directory watch fails (e.g. dir doesn't exist yet).
 * This lets the sync loop stay completely idle — no polling, no refresh attempts — until the user
 * actually logs in.
 */
function waitForTokenFileChange(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => done();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(done, 15 * 60 * 1000);
    let watcher: ReturnType<typeof fsWatch> | undefined;
    try {
      const dir = dirname(ACCESS_TOKEN_FILE);
      const file = basename(ACCESS_TOKEN_FILE);
      mkdirSync(dir, { recursive: true });
      watcher = fsWatch(dir, (_event, name) => { if (name === file) done(); });
    } catch {
      // Fall back to the timeout if the watcher can't be armed for any other reason.
    }
  });
}

/**
 * Periodically upload the snapshot until the signal aborts. Started with no usable credential, a
 * standalone `sync --watch` (`onUnauthenticated: "fail"`) throws so the command exits nonzero; the
 * run-embedded leg (`"dormant"`) logs once and waits, recovering after `argus login`. Transient
 * failures (offline, 5xx, a stale-token challenge) back off with jitter; a success resets the
 * backoff and resumes the normal interval. Repeated identical failures collapse to one log line.
 */
/** Test seam: override credential resolution and the upload (default to the real implementations). */
export interface WatchSyncDeps {
  resolveHubConfig?: (log: Log) => Promise<ResolvedHubConfig | undefined>;
  resolveCredentials?: (endpoint: string, log: Log) => Promise<PushCredentials | null>;
  push?: (opts: PushLoopOptions, credentials: PushCredentials, log: Log) => Promise<PushResult>;
  waitForTokenChange?: (signal: AbortSignal) => Promise<void>;
}

async function waitForTokenChangeOrWake(
  waitForToken: (signal: AbortSignal) => Promise<void>,
  wakeSignal: LoopWakeSignal | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!wakeSignal) {
    await waitForToken(signal);
    return;
  }
  const tokenAc = new AbortController();
  const wakeAc = new AbortController();
  const onAbort = () => {
    tokenAc.abort();
    wakeAc.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([waitForToken(tokenAc.signal), wakeSignal.wait(undefined, wakeAc.signal)]);
  } finally {
    tokenAc.abort();
    wakeAc.abort();
    signal.removeEventListener("abort", onAbort);
  }
}

export async function watchSync(opts: WatchSyncOptions, log: Log, signal: AbortSignal, deps: WatchSyncDeps = {}): Promise<void> {
  const resolveHub = deps.resolveHubConfig ?? ((logger: Log) => resolveHubConfig({ log: logger }));
  const resolveCreds = deps.resolveCredentials ?? resolveCredentials;
  const push = deps.push ?? pushSnapshotForOpts;
  const waitForToken = deps.waitForTokenChange ?? waitForTokenFileChange;
  const intervalMs = Math.max(MIN_INTERVAL_MIN, opts.intervalMin) * 60_000;

  // Startup auth preflight: fail fast for the standalone command rather than looping forever with no
  // hope of success. Mid-run staleness (below) is handled differently — it never crashes the loop.
  // Hub config is re-resolved on every pass so Settings changes apply without restarting the service.
  const initialHub = await resolveHub(log);
  const initial = initialHub
    ? ({} as PushCredentials)
    : opts.hubOnly
      ? null
      : await resolveCreds(opts.endpoint, log);
  if (!initial && opts.onUnauthenticated === "fail") {
    throw new Error(
      opts.hubOnly
        ? "Argus Hub is not configured. Set the Hub URL and key first."
        : "Not logged in. Run `argus login` first to upload to the team dashboard.",
    );
  }

  const backoff = new Backoff();
  const collapser = new RepeatCollapser(log);

  await superviseLoop(
    "upload",
    async (sig) => {
      while (!sig.aborted) {
        const hub = await resolveHub(log);
        const cred = hub
          ? ({} as PushCredentials)
          : opts.hubOnly
            ? null
            : await resolveCreds(opts.endpoint, log);
        if (!cred) {
          if (opts.hubOnly) {
            collapser.note("Hub uploads are paused until the Hub URL and key are configured.", "warn");
            await waitForNextLoop(intervalMs, sig, opts.wakeSignal);
          } else {
            // Log once, then park until the token file actually changes — no polling, no repeated
            // refresh attempts. `argus login` writes the token file, and Settings writes wake this wait.
            collapser.note("Not logged in. Pausing uploads until you run `argus login`.", "warn");
            await waitForTokenChangeOrWake(waitForToken, opts.wakeSignal, sig);
          }
          continue;
        }
        let res: PushResult;
        try {
          res = await push(opts, cred, log);
        } catch (err) {
          // Network error — the normal case on a laptop that drops off Wi-Fi. Back off quietly.
          collapser.note(`Upload failed: ${err instanceof Error ? err.message : String(err)}. Retrying.`, "warn");
          await sleep(backoff.next(), sig);
          continue;
        }
        if (res.skipped) {
          // Nothing eligible to upload (e.g. an all-local-only --source). Not an error: idle a normal
          // interval. Routed through the collapser so the same line doesn't repeat every cycle.
          collapser.note(res.body);
          backoff.reset();
          await waitForNextLoop(intervalMs, sig, opts.wakeSignal);
        } else if (res.ok) {
          collapser.flush();
          log(`Uploaded (${res.status}).`);
          backoff.reset();
          await waitForNextLoop(intervalMs, sig, opts.wakeSignal);
        } else if (res.status === 422) {
          // Schema version mismatch: permanent until one side is upgraded. The Hub's body states
          // the direction (client too new → update the Hub; too old → re-index). Stop retrying.
          logError(log, `Hub rejected upload (422): ${hubErrorMessage(res.body)}`);
          await sleep(Number.MAX_SAFE_INTEGER, sig);
        } else if (res.isAccessChallenge) {
          // Token went stale: the next pass re-reads the cache and tries a refresh. Back off meanwhile.
          collapser.note("Upload needs a fresh login. Run `argus login`. Retrying.", "warn");
          await sleep(backoff.next(), sig);
        } else {
          collapser.note(`Upload failed (${res.status}). Retrying.`, "warn");
          await sleep(backoff.next(), sig);
        }
      }
    },
    { signal, log },
  );
}
