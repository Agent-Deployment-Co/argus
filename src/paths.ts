import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CODEX_DIR = process.env.CODEX_HOME || process.env.CODEX_CONFIG_DIR || join(homedir(), ".codex");
export const GEMINI_DIR = join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini");

// The Argus data directory holds the durable, app-owned store (argus.db) and regenerable caches.
// It is no longer a "cache" location: the store is the application's central datastore.
function defaultArgusDataDir(): string {
  if (process.env.ARGUS_DATA_DIR) return process.env.ARGUS_DATA_DIR;
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "argus");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "argus");
  if (platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Argus", "Data");
  }
  return join(homedir(), ".local", "share", "argus");
}

function defaultArgusConfigDir(): string {
  if (process.env.ARGUS_CONFIG_DIR) return process.env.ARGUS_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "argus");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "argus");
  if (platform === "win32" && process.env.APPDATA) {
    return join(process.env.APPDATA, "Argus");
  }
  return join(homedir(), ".config", "argus");
}

export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
export const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
export const SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
export const INSTALLED_PLUGINS_FILE = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
export const ARGUS_DATA_DIR = defaultArgusDataDir();
export const ARGUS_CONFIG_DIR = defaultArgusConfigDir();
export const STORE_FILE = join(ARGUS_DATA_DIR, "argus.db");
export const ACCESS_TOKEN_FILE = join(ARGUS_CONFIG_DIR, "token.json");
export const PRICING_OVERRIDE_FILE = join(ARGUS_CONFIG_DIR, "pricing.json");
// The app-owned settings file (the config peer of argus.db). Holds general settings — not secrets
// (token.json) or hand-authored price tables (pricing.json), which stay as their own files.
export const CONFIG_FILE = join(ARGUS_CONFIG_DIR, "argus.json");
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
export const COWORK_SESSIONS_DIR: string | undefined =
  platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions")
    : undefined;
