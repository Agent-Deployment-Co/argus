import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CODEX_DIR = process.env.CODEX_HOME || process.env.CODEX_CONFIG_DIR || join(homedir(), ".codex");

export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
export const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
export const INSTALLED_PLUGINS_FILE = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
export const SUMMARY_CACHE_FILE = join(CLAUDE_DIR, "argus-cache.json");
export const PRICING_OVERRIDE_FILE = join(CLAUDE_DIR, "argus-pricing.json");
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
