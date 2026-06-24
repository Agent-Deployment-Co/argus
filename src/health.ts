// Cross-cutting session-health domain logic (friction rollups + the token-growth threshold), shared by
// the JS aggregate (sync path) and the SQL snapshot (serve path) so the two fold identically. A leaf
// module (no store/reporting deps) — both layers import it, the way pricing.ts / tool-categories.ts are
// shared. The legacy session-level clean/interrupted/unknown outcome proxy was removed in #122: a
// session has no single "outcome"; outcome is judged per task (TaskFact.outcome), and the mechanical
// end-of-loop signal lives on resolved_interactions.disposition.
import type { FrictionTotals } from "./types.ts";

/** Token-growth ratio (last-decile mean / first-decile mean) at or above which a session is flagged a
 *  restart candidate (the highTokenGrowthSessions recommendation input). */
export const HIGH_TOKEN_GROWTH_RATIO = 5;

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
