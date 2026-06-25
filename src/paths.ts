import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const CODEX_DIR = process.env.CODEX_HOME || process.env.CODEX_CONFIG_DIR || join(homedir(), ".codex");
export const GEMINI_DIR = join(process.env.GEMINI_CLI_HOME || homedir(), ".gemini");

type Env = NodeJS.ProcessEnv;

// The Argus data directory holds the durable, app-owned store (argus.db) and regenerable caches.
// It is no longer a "cache" location: the store is the application's central datastore.
//
// `ARGUS_HOME` is the single primary knob: it places data under `ARGUS_HOME/data` and config under
// `ARGUS_HOME/config`. The granular `ARGUS_DATA_DIR`/`ARGUS_CONFIG_DIR` vars are advanced overrides
// that win over `ARGUS_HOME` (e.g. to put the store on a separate volume). Empty values count as
// absent and fall through. `env`/`plat` are injectable so the resolution chain can be unit-tested.
export function defaultArgusDataDir(env: Env = process.env, plat: string = platform): string {
  if (env.ARGUS_DATA_DIR) return env.ARGUS_DATA_DIR;
  if (env.ARGUS_HOME) return join(env.ARGUS_HOME, "data");
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "argus");
  if (plat === "darwin") return join(homedir(), "Library", "Application Support", "argus");
  if (plat === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "Argus", "Data");
  }
  return join(homedir(), ".local", "share", "argus");
}

export function defaultArgusConfigDir(env: Env = process.env, plat: string = platform): string {
  if (env.ARGUS_CONFIG_DIR) return env.ARGUS_CONFIG_DIR;
  if (env.ARGUS_HOME) return join(env.ARGUS_HOME, "config");
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "argus");
  if (plat === "darwin") return join(homedir(), "Library", "Application Support", "argus");
  if (plat === "win32" && env.APPDATA) {
    return join(env.APPDATA, "Argus");
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
// BYO LLM API keys (#132). On macOS the OS keychain is the store and this file is unused; on Windows
// it holds DPAPI-encrypted blobs; on Linux it's a chmod-600 plaintext JSON map. Never a wire artifact.
export const SECRETS_FILE = join(ARGUS_CONFIG_DIR, "secrets.json");
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, "sessions");
export const COWORK_SESSIONS_DIR: string | undefined =
  platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions")
    : undefined;

// The Claude desktop app's Chromium HTTP cache, which holds cached claude.ai chat transcripts (#94).
// Identical entry format across platforms; only the base directory differs. `CLAUDE_DESKTOP_CACHE_DIR`
// overrides it (e.g. a non-default install or a fixture dir in tests).
function defaultClaudeChatCacheDir(): string {
  if (process.env.CLAUDE_DESKTOP_CACHE_DIR) return process.env.CLAUDE_DESKTOP_CACHE_DIR;
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "Cache", "Cache_Data");
  }
  if (platform === "win32") {
    const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(base, "Claude", "Cache", "Cache_Data");
  }
  return join(homedir(), ".config", "Claude", "Cache", "Cache_Data");
}
export const CLAUDE_CHAT_CACHE_DIR = defaultClaudeChatCacheDir();
