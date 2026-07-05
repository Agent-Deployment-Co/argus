// Serve-only builder for GET /api/health (#217): the friction rollups the Health view reads. A thin
// projection of the store's HealthRollups (the SQL work lives in the store); the high-token-growth
// count it also carries is consumed by the recommendations endpoint, not the Health view.
import type { HealthRollups } from "../store/store-contract.ts";
import type { FrictionTotals } from "../types.ts";

export interface HealthResponse {
  frictionTotals: FrictionTotals;
  /** Per-project friction, over projects with friction-observable sessions. */
  byProject: Array<{ project: string; friction: FrictionTotals }>;
}

export function buildHealth(rollups: HealthRollups): HealthResponse {
  return { frictionTotals: rollups.frictionTotals, byProject: rollups.projectFriction };
}
