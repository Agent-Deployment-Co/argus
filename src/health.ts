// Cross-cutting session-health domain logic (the #38 outcome proxy + friction rollups), shared by the
// JS aggregate (sync path) and the SQL snapshot (serve path) so the two classify and fold identically.
// A leaf module (no store/reporting deps) — both layers import it, the way pricing.ts / tool-categories.ts
// are shared. NOTE: the session-level clean/interrupted/unknown proxy and friction rollup are slated to
// be re-placed on the facts/interpretations seam in #122; keep the rule in one place until then.
import type { FrictionTotals } from "./types.ts";

/** Assistant stop reasons that mean the loop ended on its own terms (a "clean" finish). */
export const OUTCOME_CLEAN_STOP_REASONS: ReadonlySet<string> = new Set(["end_turn", "stop_sequence"]);

/** Token-growth ratio (last-decile mean / first-decile mean) at or above which a session is flagged a
 *  restart candidate (the highTokenGrowthSessions recommendation input). */
export const HIGH_TOKEN_GROWTH_RATIO = 5;

/**
 * The #38 outcome proxy as a pure function of the three signals both paths can supply:
 * - `lastMessageTs`: timestamp of the last message *in scope* (date-windowed when filtered),
 * - `lastInterruptionMs`: the session's latest interruption time (a friction signal), if any,
 * - `lastStopReason`: the last non-null assistant stop reason in scope, if any.
 *
 * Interrupted when the last interruption lands at/after the last in-scope message; else clean/unknown
 * from the terminal stop reason; else unknown.
 */
export function classifyOutcome(
  lastMessageTs: number | null,
  lastInterruptionMs: number | null | undefined,
  lastStopReason: string | null | undefined,
): "clean" | "interrupted" | "unknown" {
  if (lastInterruptionMs != null && lastMessageTs != null && lastInterruptionMs >= lastMessageTs) {
    return "interrupted";
  }
  if (lastStopReason) return OUTCOME_CLEAN_STOP_REASONS.has(lastStopReason) ? "clean" : "unknown";
  return "unknown";
}

export function emptyFrictionTotals(): FrictionTotals {
  return { observableSessions: 0, interruptions: 0, rejections: 0, compactions: 0, turns: 0 };
}

/** The per-session friction signals folded into a {@link FrictionTotals} bucket. `turns` is the
 *  session's turn count (rawTurns when known, else the friction turn count). */
export interface FrictionContribution {
  interruptions: number;
  rejections: number;
  compactions: number;
  turns: number;
}

/** Accumulate one friction-observable session's signals into a bucket (used by the JS aggregate; the
 *  SQL path does the equivalent as a grouped SUM). */
export function foldFriction(bucket: FrictionTotals, c: FrictionContribution): void {
  bucket.observableSessions += 1;
  bucket.interruptions += c.interruptions;
  bucket.rejections += c.rejections;
  bucket.compactions += c.compactions;
  bucket.turns += c.turns;
}
