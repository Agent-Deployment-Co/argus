import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { KNOWN_SOURCES, type SnapshotFilters } from "./snapshot";
import type { SessionListResponse, SessionRow, SessionSort } from "../types";

/** Everything that narrows the paginated session list: the global snapshot filters (date/source)
 *  plus the Sessions-local refinements (project label, free text, generated toggle) and the sort. */
export interface SessionListFilters extends SnapshotFilters {
  project?: string;
  q?: string;
  includeGenerated?: boolean;
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
  if (filters.includeGenerated) params.set("includeGenerated", "1");
  return `/api/sessions?${params}`;
}

/** Shown whenever the local server can't be reached at all, or answers with something that isn't
 *  the JSON we expect (e.g. a proxy's HTML error page) — both usually mean Argus isn't running. */
const OFFLINE_MESSAGE = "Couldn't reach Argus. Make sure Argus is running.";

async function fetchSessions(filters: SessionListFilters, offset: number): Promise<SessionListResponse> {
  let res: Response;
  try {
    res = await fetch(sessionsUrl(filters, offset));
  } catch {
    throw new Error(OFFLINE_MESSAGE);
  }
  // A 502/503/504 here means a dev proxy or reverse proxy is up but Argus itself isn't answering.
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new Error(OFFLINE_MESSAGE);
  if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new Error(OFFLINE_MESSAGE);
  }
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

async function fetchSessionDetail(sessionId: string): Promise<SessionRow> {
  let res: Response;
  try {
    res = await fetch(`/api/session/${encodeURIComponent(sessionId)}`);
  } catch {
    throw new Error(OFFLINE_MESSAGE);
  }
  if (!res.ok) {
    throw new Error(res.status === 404 ? "Session not found." : `Failed to load session (${res.status})`);
  }
  try {
    return (await res.json()).session as SessionRow;
  } catch {
    throw new Error(OFFLINE_MESSAGE);
  }
}

/** One session's full detail, fetched on demand (not from the bulk snapshot). */
export function useSessionDetailQuery(sessionId: string | undefined) {
  return useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => fetchSessionDetail(sessionId!),
    enabled: Boolean(sessionId),
  });
}
