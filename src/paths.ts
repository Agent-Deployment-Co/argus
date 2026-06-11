import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CODEX_DIR = process.env.CODEX_HOME || process.env.CODEX_CONFIG_DIR || join(homedir(), ".codex");
export const GEMINI_DIR = join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini");

function defaultArgusCacheDir(): string {
  if (process.env.ARGUS_CACHE_DIR) return process.env.ARGUS_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "argus");
  if (platform === "darwin") return join(homedir(), "Library", "Caches", "argus");
  if (platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Argus", "Cache");
  }
  return join(homedir(), ".cache", "argus");
}

export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
export const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
export const INSTALLED_PLUGINS_FILE = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
export const SUMMARY_CACHE_FILE = join(CLAUDE_DIR, "argus-cache.json");
export const ARGUS_CACHE_DIR = defaultArgusCacheDir();
export const FRAGMENT_CACHE_FILE = join(ARGUS_CACHE_DIR, "fragments.sqlite3");
export const ACCESS_TOKEN_FILE = join(CLAUDE_DIR, "argus-token.json");
export const PRICING_OVERRIDE_FILE = join(CLAUDE_DIR, "argus-pricing.json");
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
