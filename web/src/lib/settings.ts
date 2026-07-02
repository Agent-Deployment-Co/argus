import { useQuery } from "@tanstack/react-query";
import type { ConnectionTestResult, SecretStatus, SettingDescriptor, SettingsResponse } from "../types";
import { APP_HEADER, fetchOrOffline, jsonOrThrow } from "./http";

/** Fetch the registry-driven settings surface (categories → sections → settings), each carrying its
 *  current `argus.json` value, the effective value after the resolver, and any env override. */
export async function fetchSettings(): Promise<SettingsResponse> {
  const res = await fetchOrOffline("/api/settings");
  return jsonOrThrow<SettingsResponse>(res, "Failed to load settings");
}

/** Persist one setting into `argus.json` (atomic, server-side). `value === null` / "" clears it. The
 *  server validates with the setting's `parse()` and returns the refreshed descriptor, or a clear
 *  error for a rejected value. Sends the same-origin marker the mutating endpoints require. */
export async function saveSetting(path: string, value: unknown): Promise<SettingDescriptor> {
  const res = await fetchOrOffline(`/api/settings/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...APP_HEADER },
    body: JSON.stringify({ value }),
  });
  return (await jsonOrThrow<{ setting: SettingDescriptor }>(res, "Failed to save")).setting;
}

/** Load the settings surface. Cached briefly so reopening the screen is instant. */
export function useSettingsQuery() {
  return useQuery({ queryKey: ["settings"], queryFn: fetchSettings, staleTime: 30_000 });
}

/** Read a stored API key's masked status (#132): whether it's set and a non-reversible hint like
 *  "…WXYZ". Never returns the raw value. The endpoint requires the same-origin marker + loopback. */
export async function fetchSecretStatus(name: string): Promise<SecretStatus> {
  const res = await fetchOrOffline(`/api/settings/secrets/${encodeURIComponent(name)}`, {
    headers: { ...APP_HEADER },
  });
  return jsonOrThrow<SecretStatus>(res, "Failed to read key status");
}

/** Store an API key in the OS keychain via the secret endpoint (#132). Returns the new masked status;
 *  the raw value is never echoed back. */
export async function saveSecret(name: string, value: string): Promise<SecretStatus> {
  const res = await fetchOrOffline(`/api/settings/secrets/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...APP_HEADER },
    body: JSON.stringify({ value }),
  });
  return jsonOrThrow<SecretStatus>(res, "Failed to save key");
}

/** Run a live "test connection" against the configured LLM provider — a tiny completion to confirm the
 *  provider + key + model work. Returns { ok, provider, model?, error? }; never the completion text. */
export async function testConnection(): Promise<ConnectionTestResult> {
  const res = await fetchOrOffline("/api/settings/test-connection", {
    method: "POST",
    headers: { ...APP_HEADER },
  });
  return jsonOrThrow<ConnectionTestResult>(res, "Test failed");
}

/** Remove a stored API key (the `argus secret rm` equivalent). Returns the now-unconfigured status. */
export async function deleteSecret(name: string): Promise<SecretStatus> {
  const res = await fetchOrOffline(`/api/settings/secrets/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { ...APP_HEADER },
  });
  return jsonOrThrow<SecretStatus>(res, "Failed to remove key");
}
