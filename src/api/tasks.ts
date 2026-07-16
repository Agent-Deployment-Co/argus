// Serve-only types for the task views (#270). The store read already returns the display shape, so
// there's no folding to do here yet — this module just names the wire types the endpoint and the UI
// share (imported type-only by web/src/types.ts).

export interface RecentTask {
  sessionId: string;
  source: string;
  /** Task timestamp in epoch ms, or null when the source messages carried no timestamp. */
  ts: number | null;
  /** TaskFact id — keys per-session task metrics when a row is expanded. */
  id: string;
  description: string;
  /** Judged outcome (pass 2), when task interpretation ran; null otherwise. */
  outcome: string | null;
  /** One-line rationale for the outcome judgement; shown when a row is expanded. */
  outcomeReason: string | null;
}

export interface RecentTasksResponse {
  /** Most recent tasks first, capped by the endpoint (10). */
  tasks: RecentTask[];
}
