import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import type { Dashboard, Snapshot } from "../types";

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/snapshot");
  if (!res.ok) throw new Error(`Failed to load data (${res.status})`);
  return res.json();
}

/** Fetch the dashboard snapshot. Cached by React Query so navigating between screens is instant. */
export function useSnapshotQuery() {
  return useQuery({ queryKey: ["snapshot"], queryFn: fetchSnapshot, staleTime: 30_000 });
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
