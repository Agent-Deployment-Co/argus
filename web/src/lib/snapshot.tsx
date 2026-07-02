import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { Dashboard, DebugInfo, SessionRow, Snapshot, TaskMetrics } from "../types";
import { APP_HEADER, fetchOrOffline, jsonOrThrow } from "./http";

/** Global dashboard filters, threaded into /api/snapshot's query string (the server pushes them down
 *  to the store read). Only date-range + source are server-side; `project` stays a client-side refine
 *  in the Sessions list because the UI's project label isn't the working-directory the server filters. */
export interface SnapshotFilters {
  since?: string;
  until?: string;
  source?: string;
}

export const KNOWN_SOURCES = ["claude", "codex", "gemini", "cowork", "claude-chat"] as const;

/** Stable cache key for a filter set — also gates which values are actually sent to the server. */
function snapshotQueryKey(filters: SnapshotFilters) {
  return ["snapshot", filters.since ?? null, filters.until ?? null, sanitizedSource(filters.source)] as const;
}

/** Only forward a source the server recognizes; an unknown value (e.g. a stray `source:` token typed
 *  into the Sessions search) would otherwise 400 the whole snapshot. "all"/unset means no filter. */
function sanitizedSource(source: string | undefined): string | null {
  return source && (KNOWN_SOURCES as readonly string[]).includes(source) ? source : null;
}

function snapshotUrl(filters: SnapshotFilters): string {
  const params = new URLSearchParams();
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  const source = sanitizedSource(filters.source);
  if (source) params.set("source", source);
  const qs = params.toString();
  return qs ? `/api/snapshot?${qs}` : "/api/snapshot";
}

export interface ReindexResponse {
  tasks: NonNullable<SessionRow["tasks"]>;
  diagnostics?: { message: string }[];
}

export async function fetchSnapshot(filters: SnapshotFilters): Promise<Snapshot> {
  const res = await fetchOrOffline(snapshotUrl(filters));
  return jsonOrThrow<Snapshot>(res, "Failed to load data");
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
 *  server-side from the messages attributed to each task, not shipped in the snapshot. Backs both the
 *  task list (tokens per row) and the detail drawer. */
export async function fetchSessionTaskMetrics(
  sessionId: string,
): Promise<Record<string, TaskMetrics>> {
  const res = await fetchOrOffline(`/api/sessions/${encodeURIComponent(sessionId)}/task-metrics`);
  return (await jsonOrThrow<{ metrics: Record<string, TaskMetrics> }>(res, "Failed to load task metrics")).metrics;
}

/** Fetch the /debug payload (settings, env, paths, store/index status). Hidden diagnostics page. */
export async function fetchDebugInfo(): Promise<DebugInfo> {
  const res = await fetchOrOffline("/api/debug");
  return jsonOrThrow<DebugInfo>(res, "Failed to load debug info");
}

/** Shared query for a session's per-task metrics. The list and the drawer both call this with the
 *  same key, so React Query dedupes them into one request. */
export function useSessionTaskMetrics(sessionId: string) {
  return useQuery({
    queryKey: ["session-task-metrics", sessionId],
    queryFn: () => fetchSessionTaskMetrics(sessionId),
  });
}

/** Fetch the dashboard snapshot for the given filters. Cached by React Query (keyed on the filters)
 *  so navigating between screens is instant and changing a filter refetches just that slice; the old
 *  data stays on screen while the new slice loads. Pass `enabled: false` to skip the fetch entirely —
 *  the /debug page does this so it stays usable even when the snapshot read is broken or slow. */
export function useSnapshotQuery(filters: SnapshotFilters, enabled = true) {
  return useQuery({
    queryKey: snapshotQueryKey(filters),
    queryFn: () => fetchSnapshot(filters),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled,
  });
}

const Ctx = createContext<Snapshot | null>(null);

export function SnapshotProvider({ value, children }: { value: Snapshot; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the loaded snapshot inside a route. Routes only render once data is present. */
export function useSnapshot(): Snapshot {
  const snap = useContext(Ctx);
  if (!snap) throw new Error("useSnapshot must be used within a SnapshotProvider");
  return snap;
}

export function useDashboard(): Dashboard {
  return useSnapshot().dashboard;
}
