import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { Dashboard, SessionRow, Snapshot } from "../types";

export const SNAPSHOT_QUERY_KEY = ["snapshot"] as const;

export interface ExtractTasksResponse {
  tasks: NonNullable<SessionRow["tasks"]>;
}

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/snapshot");
  if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
  return res.json();
}

export async function extractSessionTasks(sessionId: string): Promise<ExtractTasksResponse> {
  const res = await fetch("/api/tasks/extract", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to extract tasks (${res.status})`;
    throw new Error(message);
  }
  return body as ExtractTasksResponse;
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
