// View types for the web app. The CLI's analyzed Dashboard (and its CLI-only extensions like
// bySource/byTool/health) is the single source of truth — we re-export it as a type-only import so
// the server's /api/snapshot payload and the UI never drift. Type-only imports are erased at build
// time, so no server code is pulled into the browser bundle.
import type {
  Dashboard,
  DayBucket,
  FrictionTotals,
  NamedUsage,
  PluginRow,
  SessionRow,
  ToolCategoryStat,
  ToolStat,
  Usage,
} from "../../src/types";
import type { Recommendation } from "../../src/api/recommendations";
import type { TaskMetrics } from "../../src/api/task-metrics";
import type { DebugInfo } from "../../src/api/debug-info";
import type { SessionListItem, SessionListResponse, SessionSort } from "../../src/api/session-list";
import type { SessionDetailResponse } from "../../src/api/serve";

export type {
  Dashboard,
  DayBucket,
  DebugInfo,
  FrictionTotals,
  NamedUsage,
  PluginRow,
  Recommendation,
  SessionRow,
  SessionListItem,
  SessionListResponse,
  SessionDetailResponse,
  SessionSort,
  TaskMetrics,
  ToolCategoryStat,
  ToolStat,
  Usage,
};

/** The payload served at GET /api/snapshot (see src/serve.ts). */
export interface Snapshot {
  dashboard: Dashboard;
  recommendations: Recommendation[];
  generatedAtMs: number;
}
