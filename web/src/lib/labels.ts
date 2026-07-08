import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APP_HEADER, fetchOrOffline, jsonOrThrow } from "./http";
import type { LabelRecord, LabelsResponse, SessionLabels, SessionLabelsResponse } from "../types";

// The web data layer for session/task labels (session-and-task-labels). Reads go through the shared
// fetch helpers; every write sends the same-origin APP_HEADER the server's CSRF guard requires. All
// label data is local-only — nothing here is ever synced.

const LABELS_KEY = ["labels"] as const;
const sessionLabelsKey = (sessionId: string) => ["session-labels", sessionId] as const;

// ---- Reads ----

export async function fetchLabels(): Promise<LabelRecord[]> {
  const res = await fetchOrOffline("/api/labels");
  return (await jsonOrThrow<LabelsResponse>(res, "Failed to load labels")).labels;
}

/** All active label definitions, name-sorted by the server. */
export function useLabelsQuery() {
  return useQuery({ queryKey: LABELS_KEY, queryFn: fetchLabels, staleTime: 30_000 });
}

export async function fetchSessionLabels(sessionId: string): Promise<SessionLabels> {
  const res = await fetchOrOffline(`/api/sessions/${encodeURIComponent(sessionId)}/labels`);
  return (await jsonOrThrow<SessionLabelsResponse>(res, "Failed to load session labels")).labels;
}

/** A session's labels plus its per-task labels (keyed by task position). */
export function useSessionLabelsQuery(sessionId: string | undefined) {
  return useQuery({
    queryKey: sessionLabelsKey(sessionId ?? ""),
    queryFn: () => fetchSessionLabels(sessionId!),
    enabled: Boolean(sessionId),
  });
}

// ---- Write helpers ----

/** POST/PATCH/DELETE JSON with the same-origin marker; returns the parsed body (or void). */
async function mutateJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetchOrOffline(url, {
    method,
    headers: { ...APP_HEADER, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return jsonOrThrow<T>(res, "Label update failed");
}

/** Where a label is being applied: a whole session, or one task within it (by position). */
export interface LabelTargetInput {
  sessionId: string;
  taskSeq?: number;
}

function targetUrl(target: LabelTargetInput): string {
  const base = `/api/sessions/${encodeURIComponent(target.sessionId)}`;
  return target.taskSeq === undefined ? `${base}/labels` : `${base}/tasks/${target.taskSeq}/labels`;
}

export const createLabel = (name: string) => mutateJson<{ label: LabelRecord }>("/api/labels", "POST", { name });
export const renameLabel = (id: string, name: string) =>
  mutateJson<{ label: LabelRecord }>(`/api/labels/${encodeURIComponent(id)}`, "PATCH", { name });
export const deleteLabel = (id: string) => mutateJson<{ ok: true }>(`/api/labels/${encodeURIComponent(id)}`, "DELETE");
export const assignLabel = (labelId: string, target: LabelTargetInput) =>
  mutateJson<{ ok: true }>(targetUrl(target), "POST", { labelId });
export const unassignLabel = (labelId: string, target: LabelTargetInput) =>
  mutateJson<{ ok: true }>(`${targetUrl(target)}/${encodeURIComponent(labelId)}`, "DELETE");

// ---- Mutation hooks ----

/** Managing the label catalog (create/rename/delete). A catalog change can affect any session's
 *  displayed labels, so it invalidates both the catalog and every session's labels. */
export function useLabelCatalogMutations() {
  const qc = useQueryClient();
  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: LABELS_KEY });
    void qc.invalidateQueries({ queryKey: ["session-labels"] });
  };
  return {
    create: useMutation({ mutationFn: (name: string) => createLabel(name), onSuccess: invalidateAll }),
    rename: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) => renameLabel(id, name),
      onSuccess: invalidateAll,
    }),
    remove: useMutation({ mutationFn: (id: string) => deleteLabel(id), onSuccess: invalidateAll }),
  };
}

/** Applying/removing labels on a specific session (and its tasks). Invalidates that session's labels;
 *  applying a brand-new label also refreshes the catalog. */
export function useSessionLabelMutations(sessionId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: sessionLabelsKey(sessionId) });
    void qc.invalidateQueries({ queryKey: LABELS_KEY });
  };
  return {
    assign: useMutation({
      mutationFn: ({ labelId, taskSeq }: { labelId: string; taskSeq?: number }) =>
        assignLabel(labelId, { sessionId, taskSeq }),
      onSuccess: invalidate,
    }),
    unassign: useMutation({
      mutationFn: ({ labelId, taskSeq }: { labelId: string; taskSeq?: number }) =>
        unassignLabel(labelId, { sessionId, taskSeq }),
      onSuccess: invalidate,
    }),
  };
}
