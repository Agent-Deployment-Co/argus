import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { APP_HEADER, fetchOrOffline, jsonOrThrow } from "./http";
import { KNOWN_SOURCES, type SnapshotFilters } from "./filters";
import type { SessionListResponse, SessionRow, SessionSort, TaskMetrics } from "../types";

/** Everything that narrows the paginated session list: the global snapshot filters (date/source)
 *  plus the Sessions-local refinements (project label, free text, file path) and the sort. `q`/`file`
 *  (#155) run a store-side search (conversation/task text, file-path substring). */
export interface SessionListFilters extends SnapshotFilters {
  project?: string;
  q?: string;
  file?: string;
  /** Restrict to sessions carrying at least one of these label ids (union). */
  label?: string[];
  sort: SessionSort;
}

export const SESSIONS_PAGE_SIZE = 50;

function sessionsUrl(filters: SessionListFilters, offset: number): string {
  const params = new URLSearchParams();
  params.set("sort", filters.sort);
  params.set("limit", String(SESSIONS_PAGE_SIZE));
  params.set("offset", String(offset));
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  // Only forward a recognized source (an unknown value would 400 the request).
  if (filters.source && (KNOWN_SOURCES as readonly string[]).includes(filters.source)) {
    params.set("source", filters.source);
  }
  if (filters.project) params.set("project", filters.project);
  if (filters.q) params.set("q", filters.q);
  if (filters.file) params.set("file", filters.file);
  if (filters.label?.length) params.set("label", filters.label.join(","));
  return `/api/sessions?${params}`;
}

export async function fetchSessions(filters: SessionListFilters, offset: number): Promise<SessionListResponse> {
  const res = await fetchOrOffline(sessionsUrl(filters, offset));
  return jsonOrThrow<SessionListResponse>(res, "Failed to load sessions");
}

/** Paginated session list (keyset by offset). Pages accumulate via useInfiniteQuery so "Load more"
 *  appends; changing any filter starts a fresh first page. */
export function useSessionsQuery(filters: SessionListFilters) {
  return useInfiniteQuery({
    queryKey: ["sessions", filters],
    queryFn: ({ pageParam }) => fetchSessions(filters, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last) => {
      const next = last.offset + last.rows.length;
      return next < last.total ? next : undefined;
    },
    staleTime: 30_000,
  });
}

export async function fetchSessionDetail(sessionId: string): Promise<SessionRow> {
  const res = await fetchOrOffline(`/api/session/${encodeURIComponent(sessionId)}`);
  const body = await jsonOrThrow<{ session: SessionRow }>(res, "Failed to load session");
  return body.session;
}

/** One session's full detail, fetched on demand (not from the bulk snapshot). */
export function useSessionDetailQuery(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSessionDetail(sessionId!),
    enabled: Boolean(sessionId),
  });
}

export interface ReindexResponse {
  tasks: NonNullable<SessionRow["tasks"]>;
  diagnostics?: { message: string }[];
}

/** Re-index a single session: re-read its transcript from disk and refresh it in the local store
 *  (sessions/messages/tools/tasks), with task processing on. Throws with a clear message when the
 *  transcript is gone (the session can't be reindexed). */
export async function reindexSession(sessionId: string): Promise<ReindexResponse> {
  const res = await fetchOrOffline(`/api/sessions/${encodeURIComponent(sessionId)}/reindex`, {
    method: "POST",
    headers: { ...APP_HEADER },
  });
  return jsonOrThrow<ReindexResponse>(res, "Failed to refresh");
}

/** Fetch every task's metrics for a session on demand (one request, keyed by task id) — computed
 *  server-side from the messages attributed to each task. Backs both the task list (tokens per row)
 *  and the detail drawer. */
export async function fetchSessionTaskMetrics(sessionId: string): Promise<Record<string, TaskMetrics>> {
  const res = await fetchOrOffline(`/api/sessions/${encodeURIComponent(sessionId)}/task-metrics`);
  return (await jsonOrThrow<{ metrics: Record<string, TaskMetrics> }>(res, "Failed to load task metrics")).metrics;
}

/** Shared query for a session's per-task metrics. The list and the drawer both call this with the
 *  same key, so React Query dedupes them into one request. */
export function useSessionTaskMetrics(sessionId: string) {
  return useQuery({
    queryKey: ["session-task-metrics", sessionId],
    queryFn: () => fetchSessionTaskMetrics(sessionId),
  });
}
