import { existsSync, readFileSync } from "node:fs";
import { INSTALLED_PLUGINS_FILE, SETTINGS_FILE } from "./paths.ts";
import type { PluginInfo } from "./types.ts";

function readJson(path: string): any {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

/**
 * Build the plugin inventory from settings.json (`enabledPlugins`, keyed "plugin@marketplace")
 * and plugins/installed_plugins.json (versions + install dates). Returns a map keyed by plugin
 * *name* (the part before "@"), which is what skill namespaces resolve to.
 */
export function loadPlugins(): Map<string, PluginInfo> {
  const out = new Map<string, PluginInfo>();
  const settings = readJson(SETTINGS_FILE);
  const enabled: Record<string, boolean> = settings?.enabledPlugins ?? {};
  for (const [key, on] of Object.entries(enabled)) {
    const [name, marketplace = ""] = key.split("@");
    if (!name) continue;
    out.set(name, { name, marketplace, enabled: !!on });
  }

  const installed = readJson(INSTALLED_PLUGINS_FILE);
  const plugins: Record<string, any[]> = installed?.plugins ?? {};
  for (const [key, versions] of Object.entries(plugins)) {
    const [name, marketplace = ""] = key.split("@");
    if (!name || !Array.isArray(versions) || versions.length === 0) continue;
    const latest = versions[versions.length - 1];
    const info = out.get(name) || { name, marketplace, enabled: false };
    info.installedAt = versions[0]?.installedAt;
    info.version = latest?.version;
    if (!info.marketplace) info.marketplace = marketplace;
    out.set(name, info);
  }
  return out;
}

/**
 * Map a skill attribution / invocation name to its owning plugin name, or null.
 * Plugin skills look like "plugin:skill" (e.g. "gw-github:issues" -> "gw-github").
 * Bare names ("review", "init", "weekly-update") are builtin/personal/project skills.
 */
export function skillPlugin(skill: string, plugins: Map<string, PluginInfo>): string | null {
  const ns = skill.includes(":") ? skill.split(":")[0]! : null;
  if (ns && plugins.has(ns)) return ns;
  return null;
}
