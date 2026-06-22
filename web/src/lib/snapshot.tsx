import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { Dashboard, DebugInfo, SessionRow, Snapshot, TaskMetrics } from "../types";

export const SNAPSHOT_QUERY_KEY = ["snapshot"] as const;

export interface ReindexResponse {
  tasks: NonNullable<SessionRow["tasks"]>;
  diagnostics?: { message: string }[];
}

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/snapshot");
  if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
  return res.json();
}

/** Re-index a single session: re-read its transcript from disk and refresh it in the local store
 *  (sessions/messages/tools/tasks), with task processing on. Throws with a clear message when the
 *  transcript is gone (the session can't be reindexed). */
export async function reindexSession(sessionId: string): Promise<ReindexResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reindex`, {
    method: "POST",
    // Same-origin marker: a cross-origin page can't set this without a CORS preflight the server
    // never grants, so it blocks CSRF against this mutating endpoint. Keep in sync with serve.ts.
    headers: { "X-Argus-App": "1" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to refresh (${res.status})`;
    throw new Error(message);
  }
  return body as ReindexResponse;
}

/** Fetch every task's metrics for a session on demand (one request, keyed by task id) — computed
 *  server-side from the messages attributed to each task, not shipped in the snapshot. Backs both the
 *  task list (tokens per row) and the detail drawer. */
export async function fetchSessionTaskMetrics(
  sessionId: string,
): Promise<Record<string, TaskMetrics>> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/task-metrics`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to load task metrics (${res.status})`;
    throw new Error(message);
  }
  return (body as { metrics: Record<string, TaskMetrics> }).metrics;
}

/** Fetch the /debug payload (settings, env, paths, store/index status). Hidden diagnostics page. */
export async function fetchDebugInfo(): Promise<DebugInfo> {
  const res = await fetch("/api/debug");
  if (!res.ok) throw new Error(`Failed to load debug info (${res.status})`);
  return res.json();
}

/** Shared query for a session's per-task metrics. The list and the drawer both call this with the
 *  same key, so React Query dedupes them into one request. */
export function useSessionTaskMetrics(sessionId: string) {
  return useQuery({
    queryKey: ["session-task-metrics", sessionId],
    queryFn: () => fetchSessionTaskMetrics(sessionId),
  });
}

/** Fetch the dashboard snapshot. Cached by React Query so navigating between screens is instant.
 *  Pass `enabled: false` to skip the fetch entirely — the /debug page does this so it stays usable
 *  even when the snapshot read is broken or slow. */
export function useSnapshotQuery(enabled = true) {
  return useQuery({ queryKey: SNAPSHOT_QUERY_KEY, queryFn: fetchSnapshot, staleTime: 30_000, enabled });
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
