// Serve-only builder for GET /api/plugins (#217): folds per-skill + per-MCP-server usage into
// per-plugin rows (seeding enabled-but-unused plugins) via the shared foldPlugins, so the Tools
// plugins table matches how the rest of the app attributes skills/servers to plugins.
import { foldPlugins } from "../reporting/aggregate.ts";
import type { NamedUsage, PluginInfo, PluginRow } from "../types.ts";

export interface PluginsResponse {
  byPlugin: PluginRow[];
}

export function buildPlugins(
  bySkill: NamedUsage[],
  mcpServers: Array<{ server: string; calls: number }>,
  plugins: Map<string, PluginInfo>,
): PluginsResponse {
  return { byPlugin: foldPlugins(bySkill, mcpServers, plugins) };
}
