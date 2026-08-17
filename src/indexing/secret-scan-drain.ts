// The secret-scan backlog drain (#335). Inline scanning at materialize (see ./secret-scan.ts) only
// ever covers sessions the incremental pipeline touched this run, so nothing about upgrading to a
// build that has the scanner — or refreshing the gitleaks rules — reaches a user's back catalogue.
// This pass closes that gap: it picks up every session the CURRENT scanner version hasn't stamped,
// reads its retained text back from the store, rescans it, and stamps the version.
//
// Shaped like the interpretation drain (#153) minus everything that made that one expensive: no model
// call, no network, no tokens, so no rate limiter and no per-session failure cooldown. What it does
// keep is a bound on how much it does per pass, and a yield between chunks of sessions, so a large
// backlog can't make `argus run` stop responding while it works — the rest drains on later passes.
//
// The one thing it cannot do is reach sessions indexed with text retention off (#120): their text
// only ever existed in memory during materialize, so there is nothing in the store to rescan. Those
// sessions are excluded by the eligibility predicate and counted separately by secretScanProgress, so
// `argus status` can say they need an `argus index refresh` rather than leaving the gap silent.
import type { RepeatCollapser } from "../backoff.ts";
import type { Store } from "../store/store-contract.ts";
import { logWarn, type Log } from "../logger.ts";
import {
  SECRET_SCAN_VERSION,
  scanSessionForSecrets,
  secretFindingsDigest,
} from "./secret-scan.ts";

// How many sessions one pass rescans. High compared to the interpretation drain's batch (5) because a
// scan is regex over text already on disk, not a model call — a fresh upgrade should catch up in a
// pass or two, not a week of watch ticks — but still bounded so one pass has an end.
const SECRET_SCAN_BATCH_PER_PASS = 500;

// Hand the event loop back every this many sessions. Store reads and the regex pass are synchronous
// under the hood, so without this a 500-session pass would block `argus run`'s other legs (serve, the
// watch timers) for its whole duration.
const YIELD_EVERY = 25;

// A session that fails to scan (an unreadable row, say) stays eligible, so without a backoff it would
// sit at the front of the newest-first queue and re-log its failure on every watch tick forever. Same
// time-based cooldown as the interpretation drain: never a permanent drop, always self-recovering.
// Module-level so it survives drain ticks within `--watch`.
const RETRY_COOLDOWN_MS = 15 * 60_000;
const retryAfterMs = new Map<string, number>();

const yieldToLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * One pass of the secret-scan backlog drain (#335). Rescans up to SECRET_SCAN_BATCH_PER_PASS eligible
 * sessions (never scanned, or scanned by an older scanner version) and stamps each one. Silent when
 * nothing is eligible — the steady state, since materialize stamps every session it writes. Never
 * throws on a single bad session; only a fatal store error propagates, so the supervised index loop
 * isn't restarted by one unreadable session.
 */
export async function runSecretScanDrain(
  store: Store,
  log?: Log,
  collapser?: RepeatCollapser,
): Promise<void> {
  const now = Date.now();
  const batch = (
    await store.readPendingSecretScanSessions(SECRET_SCAN_VERSION, SECRET_SCAN_BATCH_PER_PASS)
  ).filter((id) => (retryAfterMs.get(id) ?? 0) <= now);
  if (!batch.length) return; // quiet when idle — no noise every tick

  // Heartbeat only when the pass is big enough to take a noticeable moment; for a handful of sessions
  // the summary below says everything and two lines for one session is just noise.
  if (batch.length > YIELD_EVERY) {
    log?.(`Checking ${batch.length} earlier sessions for exposed credentials…`);
  }
  let scanned = 0;
  let flagged = 0;
  let failures = 0;
  for (const [index, sessionId] of batch.entries()) {
    try {
      const interactions = await store.readSessionInteractions(sessionId);
      const findings = scanSessionForSecrets({ interactions });
      await store.writeSessionSecretFindings(sessionId, {
        version: SECRET_SCAN_VERSION,
        digest: secretFindingsDigest(findings),
        findings,
      });
      scanned++;
      retryAfterMs.delete(sessionId);
      if (findings.length) flagged++;
    } catch (err) {
      // One session we couldn't read or write. Leave it unstamped so a later pass retries, back it off
      // for the cooldown, and keep going — a single odd session must not stall the whole backlog.
      failures++;
      retryAfterMs.set(sessionId, now + RETRY_COOLDOWN_MS);
      if (log) logWarn(log, `  ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((index + 1) % YIELD_EVERY === 0) await yieldToLoop();
  }

  if (scanned > 0) {
    const progress = await store.secretScanProgress(SECRET_SCAN_VERSION);
    const found = flagged ? ` Found possible credentials in ${flagged}.` : "";
    const left = progress.pending ? ` ${progress.pending} left to check.` : "";
    log?.(
      `Checked ${scanned} session${scanned === 1 ? "" : "s"} for exposed credentials.${found}${left}`,
    );
  }
  if (failures > 0) {
    const note = `Couldn't check ${failures} session${failures === 1 ? "" : "s"} for exposed credentials; will retry later.`;
    if (collapser) collapser.note(note, "warn");
    else if (log) logWarn(log, note);
  }
}
