import { existsSync, readFileSync } from "node:fs";
import { INSTALLED_PLUGINS_FILE, SETTINGS_FILE } from "../paths.ts";
import type { PluginInfo } from "../types.ts";

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
 * *name* (the part before "@"), which is what skill namespaces resolve to. Pure — takes the
 * already-parsed JSON rather than reading disk itself, so a caller with no filesystem of its own
 * (#281's Cloudflare demo, which reads the same two blobs back out of `Store.getPluginInventoryJson`
 * instead) can build the identical inventory. `loadPlugins()` below is the CLI's thin disk-reading
 * wrapper over this.
 */
export function buildPluginInventory(settingsJson: unknown, installedPluginsJson: unknown): Map<string, PluginInfo> {
  const out = new Map<string, PluginInfo>();
  const enabled: Record<string, boolean> = (settingsJson as any)?.enabledPlugins ?? {};
  for (const [key, on] of Object.entries(enabled)) {
    const [name, marketplace = ""] = key.split("@");
    if (!name) continue;
    out.set(name, { name, marketplace, enabled: !!on });
  }

  const plugins: Record<string, any[]> = (installedPluginsJson as any)?.plugins ?? {};
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

/** The CLI's disk-reading entry point — reads `SETTINGS_FILE`/`INSTALLED_PLUGINS_FILE` and delegates
 *  to the pure `buildPluginInventory`. */
export function loadPlugins(): Map<string, PluginInfo> {
  return buildPluginInventory(readJson(SETTINGS_FILE), readJson(INSTALLED_PLUGINS_FILE));
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
