// The Interpret stage: the one model-driven, opt-in step of the pipeline. It derives interpretations
// of a session that aren't in the transcript — the #91/#122 two-pass task extraction (segment tasks
// over the session's interactions, then judge per-task outcome/frustration). Facts (Parse/Reconcile)
// are deterministic and always run; Interpret runs only when enabled.
//
// Decoupled from the structural index (#153): interpretation runs AFTER materialize and reads its
// inputs back from the store (resolved_interactions + retained text via readSessionInteractions) — the
// single text source — never from the in-memory parse artifacts. Two triggers share one implementation:
//   - the throttled background drain (`runInterpretationDrain`), for all automatic/bulk interpretation, and
//   - the immediate inline path (`interpretSession`), for an explicit per-session refresh.
import type { ParserDiagnostic, Store, TaskFact } from "../../store/store-contract.ts";
import type { ResolvedSessionInterpretation } from "../../config.ts";
import type { RepeatCollapser } from "../../backoff.ts";
import { resolveApiKey } from "../../secrets.ts";
import { extractTasksWithOutcome } from "./task-extraction.ts";
import { logWarn, type ArgusLogLevel, type Log } from "../../logger.ts";

// The interpreter's own implementation version (#153) — provenance for "what produced this
// interpretation", stamped on each session it interprets. Content-independent: bump it when the
// interpreter's behavior changes (prompts, passes, model defaults). It is DELIBERATELY not part of
// eligibility — a bump alone never re-triggers the background drain; only a content change or an
// explicit refresh re-interprets (which then records the current version).
export const INTERPRETER_VERSION = "2";

// How many sessions the drain interprets per index pass. Bounds any single invocation's burst (a bare
// `argus index` interprets at most this many, then exits); the persisted hourly bucket bounds the rate
// across passes. Kept small and internal for now (a future setting can expose it).
const INTERPRET_BATCH_PER_TICK = 5;

// Pass-1 (segmentation) failure codes from task-extraction.ts: the model call failed or its output
// couldn't be read, so we got NO tasks for a reason other than "the session genuinely has none". A
// session that hit one of these must stay eligible (retry later), not be stamped as interpreted.
const EXTRACTION_FAILURE_CODES = new Set(["task_extraction_failed", "task_extraction_bad_response"]);

// Failure cooldown: after a failed interpret, a session is skipped only until this long has passed, so a
// transiently-failing session can't sit at the front of the newest-first queue and get hammered (or
// starve healthy sessions) every tick — but it always recovers on its own once the cooldown elapses.
// This is a time-based backoff, NOT a permanent in-memory poison set: a session is never dropped for the
// life of the process. Cleared immediately on success. Module-level so it survives drain ticks within
// `--watch`. (`Date.now()` is fine here — the drain is ordinary runtime code, not a workflow script.)
const RETRY_COOLDOWN_MS = 15 * 60_000;
const retryAfterMs = new Map<string, number>();

/** True when automatic task extraction should run for this call. */
export function sessionInterpretationActive(taskExtraction: ResolvedSessionInterpretation | undefined): boolean {
  return !!taskExtraction?.enabled && taskExtraction.llm.provider !== "off";
}

/** Fill in the API key once (env var → secret store). Only providers that declare a key env var get
 *  one — config sets `apiKeyEnv` only for those. The LLM client is kept pure of secret access, so the
 *  key is resolved here and handed down on `llm.apiKey`. A no-op once the key is already present, so
 *  the drain can resolve once and pass the result into every per-session interpret. */
async function withResolvedApiKey(
  taskExtraction: ResolvedSessionInterpretation,
): Promise<ResolvedSessionInterpretation> {
  const { llm } = taskExtraction;
  if (!llm.apiKeyEnv || llm.apiKey) return taskExtraction;
  const apiKey = await resolveApiKey(llm.apiKeyEnv);
  return { ...taskExtraction, llm: { ...llm, apiKey } };
}

/**
 * Interpret one session from the store: read its interactions (with retained text), run the two-pass
 * extraction, and — unless pass 1 failed — write the tasks (stamping interpreted_at_ms +
 * INTERPRETER_VERSION). Returns the tasks, any diagnostics, and whether it actually wrote (`interpreted`
 * false on a pass-1 failure, leaving the session eligible and its prior interpretation intact). Not
 * throttled — used by the inline refresh and, per session, by the drain.
 */
export async function interpretSession(
  store: Store,
  sessionId: string,
  taskExtraction: ResolvedSessionInterpretation,
): Promise<{ tasks: TaskFact[]; diagnostics: ParserDiagnostic[]; interpreted: boolean }> {
  const resolved = await withResolvedApiKey(taskExtraction);
  const interactions = await store.readSessionInteractions(sessionId);
  const invocations = await store.readSessionInvocations(sessionId);
  const { title, summary, tasks, diagnostics } = await extractTasksWithOutcome(
    sessionId,
    interactions,
    resolved,
    invocations,
  );
  if (diagnostics.some((d) => EXTRACTION_FAILURE_CODES.has(d.code))) {
    return { tasks, diagnostics, interpreted: false };
  }
  // Write the model title/summary (or null when empty) alongside the tasks + interpretation stamp.
  await store.writeSessionTasks(sessionId, tasks, INTERPRETER_VERSION, title || null, summary || null);
  return { tasks, diagnostics, interpreted: true };
}

/**
 * One throttled pass of the background interpretation drain (#153). Selects the newest eligible
 * sessions (never-interpreted or content-changed-since), takes that many credits from the persisted
 * hourly rate limiter, and interprets up to the granted count from the store. Quiet when nothing is eligible;
 * a paused-by-throttle line and per-pass failures route through the optional RepeatCollapser so a
 * long-running `--watch` doesn't repeat them every tick. Never throws on a single bad session — only a
 * fatal store error propagates (so the supervised index loop isn't restarted by routine LLM hiccups).
 */
export async function runInterpretationDrain(
  store: Store,
  taskExtraction: ResolvedSessionInterpretation,
  log?: Log,
  collapser?: RepeatCollapser,
): Promise<void> {
  if (!sessionInterpretationActive(taskExtraction)) return;
  const maxPerHour = taskExtraction.maxSessionsPerHour;
  if (maxPerHour <= 0) return;
  const note = (msg: string, level: ArgusLogLevel = "info") => {
    if (collapser) {
      collapser.note(msg, level);
    } else if (log) {
      level === "warn" ? logWarn(log, msg) : log(msg);
    }
  };

  // Over-fetch a little so the cooldown filter can drop recently-failed sessions without starving the
  // batch, then cap at the per-tick batch size.
  const now = Date.now();
  const candidates = (await store.readPendingInterpretationSessions(INTERPRET_BATCH_PER_TICK * 2))
    .filter((id) => (retryAfterMs.get(id) ?? 0) <= now)
    .slice(0, INTERPRET_BATCH_PER_TICK);
  if (!candidates.length) return; // quiet when idle — no noise every tick

  const granted = await store.takeInterpretCredits(candidates.length, maxPerHour);
  if (granted <= 0) {
    note(`Reached the hourly session-interpretation limit (${maxPerHour}/hr); resuming later.`);
    return;
  }

  const resolved = await withResolvedApiKey(taskExtraction);
  const batch = candidates.slice(0, granted);
  // Each session is a model call (often slow), so emit a per-session heartbeat BEFORE the call — a long
  // pass must never look hung. These lines are distinct per session, so they go straight to the log
  // (not the collapser); the collapser is only for the repeated throttle-pause / failure-summary lines.
  log?.(
    `Interpreting ${batch.length} session${batch.length === 1 ? "" : "s"} this pass (up to ${maxPerHour}/hr) — running an AI model on each…`,
  );
  let done = 0;
  let failures = 0;
  let n = 0;
  for (const sessionId of batch) {
    log?.(`  [${++n}/${batch.length}] ${sessionId.replace(/^[^:]+:/, "").slice(0, 8)}…`);
    try {
      const { interpreted, diagnostics } = await interpretSession(store, sessionId, resolved);
      if (interpreted) {
        done++;
        retryAfterMs.delete(sessionId);
      } else {
        failures++;
        retryAfterMs.set(sessionId, now + RETRY_COOLDOWN_MS);
        // Surface WHY it failed — the pass-1 failure diagnostics carry the provider error / bad-output
        // reason. Without this the drain only says "couldn't interpret N", hiding the cause. These are
        // distinct per session and the failed session is on cooldown, so they don't spam every tick.
        const reasons = diagnostics
          .filter((d) => EXTRACTION_FAILURE_CODES.has(d.code))
          .map((d) => d.message);
        for (const reason of reasons.length ? reasons : ["no tasks and no diagnostic (unexpected)"]) {
          if (log) logWarn(log, `  ${sessionId}: ${reason}`);
        }
      }
    } catch (err) {
      // Routine per-session failure (e.g. a transient provider error surfacing as a throw): leave the
      // session eligible (unstamped) but back it off for the cooldown so the next tick isn't blocked on
      // it, then keep draining. It recovers automatically once the cooldown elapses.
      failures++;
      retryAfterMs.set(sessionId, now + RETRY_COOLDOWN_MS);
      if (log) logWarn(log, `  ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (done > 0) {
    const progress = await store.interpretationProgress();
    log?.(
      `Interpreted ${done} session${done === 1 ? "" : "s"} this pass — ${progress.interpreted} done, ${progress.pending} remaining.`,
    );
  }
  if (failures > 0) {
    note(`Couldn't interpret ${failures} session${failures === 1 ? "" : "s"} this pass; will retry later.`, "warn");
  }
}
