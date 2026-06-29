import { useQuery } from "@tanstack/react-query";
import type { ConnectionTestResult, SecretStatus, SettingDescriptor, SettingsResponse } from "../types";

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

/** Read a stored API key's masked status (#132): whether it's set and a non-reversible hint like
 *  "…WXYZ". Never returns the raw value. The endpoint requires the same-origin marker + loopback. */
export async function fetchSecretStatus(name: string): Promise<SecretStatus> {
  const res = await fetch(`/api/settings/secrets/${encodeURIComponent(name)}`, {
    headers: { "X-Argus-App": "1" },
  });
  if (!res.ok) throw new Error(`Failed to read key status (${res.status})`);
  return res.json();
}

/** Store an API key in the OS keychain via the secret endpoint (#132). Returns the new masked status;
 *  the raw value is never echoed back. */
export async function saveSecret(name: string, value: string): Promise<SecretStatus> {
  const res = await fetch(`/api/settings/secrets/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Argus-App": "1" },
    body: JSON.stringify({ value }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to save key (${res.status})`;
    throw new Error(message);
  }
  return body as SecretStatus;
}

/** Run a live "test connection" against the configured LLM provider — a tiny completion to confirm the
 *  provider + key + model work. Returns { ok, provider, model?, error? }; never the completion text. */
export async function testConnection(): Promise<ConnectionTestResult> {
  const res = await fetch("/api/settings/test-connection", {
    method: "POST",
    headers: { "X-Argus-App": "1" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Test failed (${res.status})`;
    throw new Error(message);
  }
  return body as ConnectionTestResult;
}

/** Remove a stored API key (the `argus secret rm` equivalent). Returns the now-unconfigured status. */
export async function deleteSecret(name: string): Promise<SecretStatus> {
  const res = await fetch(`/api/settings/secrets/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "X-Argus-App": "1" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Failed to remove key (${res.status})`;
    throw new Error(message);
  }
  return body as SecretStatus;
}
