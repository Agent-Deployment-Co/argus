import { useQuery } from "@tanstack/react-query";
import type { SettingDescriptor, SettingsResponse } from "../types";

/** Fetch the registry-driven settings surface (categories → sections → settings), each carrying its
 *  current `argus.json` value, the effective value after the resolver, and any env override. */
export async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
  return res.json();
}

/** Persist one setting into `argus.json` (atomic, server-side). `value === null` / "" clears it. The
 *  server validates with the setting's `parse()` and returns the refreshed descriptor, or a clear
 *  error for a rejected value. Sends the same-origin marker the mutating endpoints require. */
export async function saveSetting(path: string, value: unknown): Promise<SettingDescriptor> {
  const res = await fetch(`/api/settings/${encodeURIComponent(path)}`, {
    method: "PUT",
    // Same-origin marker (matches serve.ts rejectCrossSite); a cross-origin page can't set it without
    // a preflight the server never grants, so it blocks CSRF against this mutating endpoint.
    headers: { "Content-Type": "application/json", "X-Argus-App": "1" },
    body: JSON.stringify({ value }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to save (${res.status})`;
    throw new Error(message);
  }
  return (body as { setting: SettingDescriptor }).setting;
}

/** Load the settings surface. Cached briefly so reopening the screen is instant. */
export function useSettingsQuery() {
  return useQuery({ queryKey: ["settings"], queryFn: fetchSettings, staleTime: 30_000 });
}
