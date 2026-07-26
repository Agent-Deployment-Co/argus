import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { APP_HEADER, fetchOrOffline, jsonOrThrow } from "./http";
import { KNOWN_SOURCES, type SnapshotFilters } from "./filters";
import type {
  SessionInteractionsResponse,
  SessionListResponse,
  SessionProvenance,
  SessionRow,
  SessionSort,
  TaskMetrics,
} from "../types";

/** Everything that narrows the paginated session list: the global snapshot filters (date/source)
 *  plus the Sessions-local refinements (project label, free text, file path) and the sort. `q`/`file`
 *  (#155) run a store-side search (conversation/task text, file-path substring). */
export interface SessionListFilters extends SnapshotFilters {
  project?: string;
  q?: string;
  file?: string;
  /** Restrict to sessions carrying these label ids. */
  label?: string[];
  /** How `label` narrows when it has more than one id: "any" (union, default) or "all" (intersection). */
  labelMode?: "any" | "all";
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
  if (filters.label?.length) {
    params.set("label", filters.label.join(","));
    if (filters.labelMode === "all") params.set("labelMode", "all");
  }
  return `/api/sessions?${params}`;
}

export async function fetchSessions(filters: SessionListFilters, offset: number): Promise<SessionListResponse> {
  const res = await fetchOrOffline(sessionsUrl(filters, offset));
  return jsonOrThrow<SessionListResponse>(res, "Failed to load sessions");
}

/** Page through every session matching `filters` (beyond what's loaded in the list), returning just
 *  the ids — backs "Select all N matching sessions" in bulk mode. Reuses the same filter/pagination
 *  contract as the list itself rather than a dedicated "resolve filter to ids" endpoint. */
export async function fetchAllSessionIds(filters: SessionListFilters): Promise<string[]> {
  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchSessions(filters, offset);
    ids.push(...page.rows.map((r) => r.sessionId));
    offset += page.rows.length;
    if (offset >= page.total || page.rows.length === 0) break;
  }
  return ids;
}

/** Paginated session list (keyset by offset). Pages accumulate via useInfiniteQuery as the list
 *  scrolls; changing any filter starts a fresh first page. */
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

/** Flag/unflag a session as hidden (local-only UI state): hidden sessions drop out of the sessions
 *  list and search, but their usage still counts in aggregate rollups. */
export async function setSessionHidden(sessionId: string, hidden: boolean): Promise<{ hidden: boolean }> {
  const res = await fetchOrOffline(`/api/sessions/${encodeURIComponent(sessionId)}/hidden`, {
    method: "POST",
    headers: { ...APP_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ hidden }),
  });
  return jsonOrThrow<{ hidden: boolean }>(res, hidden ? "Failed to hide session" : "Failed to unhide session");
}

/** Flag/unflag many sessions as hidden at once (bulk mode). */
export async function setSessionsHidden(sessionIds: string[], hidden: boolean): Promise<{ hidden: boolean }> {
  const res = await fetchOrOffline("/api/sessions/bulk/hidden", {
    method: "POST",
    headers: { ...APP_HEADER, "content-type": "application/json" },
    body: JSON.stringify({ sessionIds, hidden }),
  });
  return jsonOrThrow<{ hidden: boolean }>(res, hidden ? "Failed to hide sessions" : "Failed to unhide sessions");
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

/** A session's interaction timeline (prompt -> loop summary -> response), fetched on demand. */
export async function fetchSessionInteractions(sessionId: string): Promise<SessionInteractionsResponse> {
  const res = await fetchOrOffline(`/api/session/${encodeURIComponent(sessionId)}/interactions`);
  return jsonOrThrow<SessionInteractionsResponse>(res, "Failed to load the session timeline");
}

/** The interaction timeline, fetched only when `enabled` (i.e. the Timeline tab is open). */
export function useSessionInteractionsQuery(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["session-interactions", sessionId],
    queryFn: () => fetchSessionInteractions(sessionId!),
    enabled: enabled && Boolean(sessionId),
  });
}

/** A session's structural-index provenance (transcript files + lineage), fetched on demand. */
export async function fetchSessionProvenance(sessionId: string): Promise<SessionProvenance> {
  const res = await fetchOrOffline(`/api/session/${encodeURIComponent(sessionId)}/provenance`);
  return jsonOrThrow<SessionProvenance>(res, "Failed to load session data");
}

/** Session provenance, fetched only when `enabled` (i.e. the Details tab is open). */
export function useSessionProvenanceQuery(sessionId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["session-provenance", sessionId],
    queryFn: () => fetchSessionProvenance(sessionId!),
    enabled: enabled && Boolean(sessionId),
  });
}
