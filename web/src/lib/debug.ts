import { fetchOrOffline, jsonOrThrow } from "./http";
import type { DebugInfo } from "../types";

/** Fetch the /debug payload (settings, env, paths, store/index status). Hidden diagnostics page. */
export async function fetchDebugInfo(): Promise<DebugInfo> {
  const res = await fetchOrOffline("/api/debug");
  return jsonOrThrow<DebugInfo>(res, "Failed to load debug info");
}
