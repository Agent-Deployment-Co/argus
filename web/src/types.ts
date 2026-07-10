// View types for the web app. The CLI's analyzed Dashboard (and its CLI-only extensions like
// bySource/byTool/health) is the single source of truth — we re-export it as a type-only import so
// the server's per-view API payloads and the UI never drift. Type-only imports are erased at build
// time, so no server code is pulled into the browser bundle.
import type {
  Dashboard,
  DayBucket,
  FrictionTotals,
  NamedUsage,
  PluginRow,
  SessionRow,
  SessionToolStat,
  ToolCategoryStat,
  ToolStat,
  Usage,
} from "../../src/types";
import type { Recommendation } from "../../src/api/recommendations";
import type { TaskMetrics } from "../../src/api/task-metrics";
import type { DebugInfo } from "../../src/api/debug-info";
import type { SessionListItem, SessionListResponse, SessionSort } from "../../src/api/session-list";
import type {
  SessionInteractionsResponse,
  TimelineInteraction,
  TimelineTask,
  TimelineTool,
} from "../../src/api/session-interactions";
import type {
  BulkSessionLabelsResponse,
  LabelResponse,
  LabelsResponse,
  RecommendationsResponse,
  SessionDetailResponse,
  SessionLabelsResponse,
} from "../../src/api/serve";
// Label domain types (session-and-task-labels), local-only — imported type-only so the store's
// label records and the UI can't drift.
import type {
  AppliedLabel,
  LabelAppliedBy,
  LabelOrigin,
  LabelRecord,
  SessionLabels,
  SessionProvenance,
  SessionProvenanceFile,
} from "../../src/store/store-contract";
// Per-view endpoint payloads (#217) — the single source of truth for each view's shape, imported
// type-only so the server responses and the UI can't drift.
import type {
  UsageByModelResponse,
  UsageByProjectResponse,
  UsageBySourceResponse,
  UsageDailyResponse,
} from "../../src/api/usage";
import type {
  ByMcpServerResponse,
  ByToolCategoryResponse,
  ByToolResponse,
  HeaviestResultsResponse,
  SkillsResponse,
} from "../../src/api/tools";
import type { PluginsResponse } from "../../src/api/plugins";
import type { HealthResponse } from "../../src/api/health";
import type {
  ConnectionTestDescriptor,
  ConnectionTestResult,
  SecretFieldDescriptor,
  SettingDescriptor,
  SettingsCategory,
  SettingsResponse,
  SettingsSection,
  SettingOverride,
} from "../../src/api/settings";
import type { SettingUi } from "../../src/config";
import type { SecretStatus } from "../../src/secrets";

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
  SessionInteractionsResponse,
  TimelineInteraction,
  TimelineTask,
  TimelineTool,
  SessionSort,
  ConnectionTestDescriptor,
  ConnectionTestResult,
  SecretFieldDescriptor,
  SecretStatus,
  SettingDescriptor,
  SettingsCategory,
  SettingsResponse,
  SettingsSection,
  SettingOverride,
  SettingUi,
  TaskMetrics,
  SessionToolStat,
  ToolCategoryStat,
  ToolStat,
  Usage,
  // Per-view endpoint payloads (#217).
  UsageDailyResponse,
  UsageByModelResponse,
  UsageBySourceResponse,
  UsageByProjectResponse,
  SkillsResponse,
  ByToolResponse,
  ByToolCategoryResponse,
  ByMcpServerResponse,
  HeaviestResultsResponse,
  PluginsResponse,
  HealthResponse,
  RecommendationsResponse,
  // Labels (session-and-task-labels).
  AppliedLabel,
  BulkSessionLabelsResponse,
  LabelAppliedBy,
  LabelOrigin,
  LabelRecord,
  LabelResponse,
  LabelsResponse,
  SessionLabels,
  SessionLabelsResponse,
  SessionProvenance,
  SessionProvenanceFile,
};
