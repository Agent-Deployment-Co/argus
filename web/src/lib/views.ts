// Per-view data hooks (#217): one small React Query hook per dashboard endpoint, replacing the single
// monolithic snapshot fetch. Each view fetches only what its own widgets read, keyed on the shared
// filters (date range + source) so changing a filter refetches just that slice while the old data
// stays on screen. All follow the same shape via `makeViewHook`.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { appendViewParams, sanitizedSource, type SnapshotFilters } from "./filters";
import { fetchOrOffline, jsonOrThrow } from "./http";
import type {
  ByMcpServerResponse,
  ByToolCategoryResponse,
  ByToolResponse,
  DailyActivityResponse,
  HealthResponse,
  HeaviestResultsResponse,
  PluginsResponse,
  RecommendationsResponse,
  SessionsBySourceResponse,
  SkillsResponse,
  UsageByModelResponse,
  UsageByProjectResponse,
  UsageBySourceDailyResponse,
  UsageBySourceResponse,
  UsageDailyResponse,
} from "../types";

/** Fold several view queries into one loading/error state so a route can gate its render the way the
 *  old global snapshot did: show a loading state until every first load lands, then surface the first
 *  error if any. On refetch (data already present) it reports neither — the FilterBar shows activity. */
export function viewGate(
  queries: Array<{ isPending: boolean; isError: boolean; error: unknown }>,
): { pending: boolean; errorMessage: string | null } {
  if (queries.some((q) => q.isPending)) return { pending: true, errorMessage: null };
  const errored = queries.find((q) => q.isError);
  return { pending: false, errorMessage: errored ? (errored.error as Error).message : null };
}

/** The active dashboard filters from the router search params. Every dashboard route reads these and
 *  passes them to its view hooks (there's no global snapshot context anymore). */
export function useDashboardFilters(): SnapshotFilters {
  return useSearch({ strict: false, select: (s) => ({ since: s.since, until: s.until, source: s.source }) });
}

function viewUrl(path: string, filters: SnapshotFilters): string {
  const params = new URLSearchParams();
  appendViewParams(params, filters);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Shared leading key element for every dashboard-view query, so the FilterBar's refreshing
 *  indicator can watch just these (via `useIsFetching({ queryKey: [VIEW_QUERY_KEY] })`) and not spin
 *  for unrelated fetches like session detail, list pagination, task-metrics, or /api/debug. */
export const VIEW_QUERY_KEY = "dashboard-view";

/** Build a React Query hook for one view endpoint. The key is the shared prefix + path + the sent
 *  filter values, so distinct endpoints and filter sets cache independently and rapid reloads reuse
 *  the last result. */
function makeViewHook<T>(path: string) {
  return (filters: SnapshotFilters, enabled = true) =>
    useQuery({
      queryKey: [VIEW_QUERY_KEY, path, filters.since ?? null, filters.until ?? null, sanitizedSource(filters.source)] as const,
      queryFn: () => fetchOrOffline(viewUrl(path, filters)).then((res) => jsonOrThrow<T>(res, "Failed to load data")),
      staleTime: 30_000,
      placeholderData: keepPreviousData,
      enabled,
    });
}

export const useUsageDailyQuery = makeViewHook<UsageDailyResponse>("/api/usage/daily");
export const useUsageByModelQuery = makeViewHook<UsageByModelResponse>("/api/usage/by-model");
export const useUsageBySourceQuery = makeViewHook<UsageBySourceResponse>("/api/usage/by-source");
export const useUsageBySourceDailyQuery = makeViewHook<UsageBySourceDailyResponse>("/api/usage/by-source-daily");
export const useDailyActivityQuery = makeViewHook<DailyActivityResponse>("/api/usage/daily-activity");
export const useUsageByProjectQuery = makeViewHook<UsageByProjectResponse>("/api/usage/by-project");
export const useSessionsBySourceQuery = makeViewHook<SessionsBySourceResponse>("/api/usage/sessions-by-source");
export const useSkillsQuery = makeViewHook<SkillsResponse>("/api/skills");
export const useToolsByToolQuery = makeViewHook<ByToolResponse>("/api/tools/by-tool");
export const useToolsByCategoryQuery = makeViewHook<ByToolCategoryResponse>("/api/tools/by-category");
export const useMcpServersQuery = makeViewHook<ByMcpServerResponse>("/api/tools/by-mcp-server");
export const useHeaviestResultsQuery = makeViewHook<HeaviestResultsResponse>("/api/tools/heaviest-results");
export const usePluginsQuery = makeViewHook<PluginsResponse>("/api/plugins");
export const useHealthQuery = makeViewHook<HealthResponse>("/api/health");
export const useRecommendationsQuery = makeViewHook<RecommendationsResponse>("/api/recommendations");
