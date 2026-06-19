import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { Dashboard, SessionRow, Snapshot, TaskMetrics } from "../types";

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

/** Fetch one task's metrics (tokens, cost, tool calls) on demand — computed server-side from the
 *  messages attributed to the task, not shipped in the snapshot. */
export async function fetchTaskMetrics(sessionId: string, taskId: string): Promise<TaskMetrics> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to load task metrics (${res.status})`;
    throw new Error(message);
  }
  return (body as { metrics: TaskMetrics }).metrics;
}

/** Fetch the dashboard snapshot. Cached by React Query so navigating between screens is instant. */
export function useSnapshotQuery() {
  return useQuery({ queryKey: SNAPSHOT_QUERY_KEY, queryFn: fetchSnapshot, staleTime: 30_000 });
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
