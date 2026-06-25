// The payload behind the hidden /debug page: a snapshot of the settings, environment, resolved
// paths, and store/index status that explain why Argus is behaving the way it is. Read-only and
// best-effort — every section degrades gracefully so the page still renders when something is off.
import { existsSync, statSync } from "node:fs";
import { loadConfig, resolveTaskExtraction, type ArgusConfig } from "../config.ts";
import { scanStore, type SourceScan } from "../indexing/pipeline.ts";
import {
  ARGUS_CONFIG_DIR,
  ARGUS_DATA_DIR,
  CLAUDE_CHAT_CACHE_DIR,
  CLAUDE_DIR,
  CODEX_DIR,
  CODEX_SESSIONS_DIR,
  CONFIG_FILE,
  COWORK_SESSIONS_DIR,
  GEMINI_DIR,
  HISTORY_FILE,
  PROJECTS_DIR,
  SETTINGS_FILE,
  STORE_FILE,
} from "../paths.ts";
import { ALL_SOURCES } from "../reporting/dashboard-builder.ts";
import { openStore, STORE_SCHEMA_VERSION } from "../store/store.ts";
import pkg from "../../package.json" with { type: "json" };

export interface PathEntry {
  name: string;
  path: string;
  exists: boolean;
}

export interface EnvEntry {
  name: string;
  value: string | null;
}

export interface DebugInfo {
  generatedAtMs: number;
  version: { argus: string; storeSchema: number };
  runtime: {
    runtime: string;
    platform: string;
    arch: string;
    pid: number;
    uptimeSec: number;
    cwd: string;
    /** serve reads the store read-only; writes only happen via explicit Refresh / `argus index`. */
    serveReadOnly: boolean;
  };
  /** Resolved filesystem locations + whether they exist (surfaces config-dir mismatches). */
  paths: PathEntry[];
  /** Curated env vars that steer Argus (config dirs, data dir, task-extraction). Values shown as-is;
   *  these aren't secrets (tokens live in token.json, not the environment). */
  env: EnvEntry[];
  /** Contents of argus.json (settings only) plus the resolved task-extraction settings. */
  config: ArgusConfig;
  taskExtraction: { enabled: boolean; provider: string; model?: string };
  store: {
    path: string;
    exists: boolean;
    sizeBytes: number | null;
    schemaVersion: number | null;
    expectedSchemaVersion: number;
    sessions: number | null;
    messages: number | null;
    tasks: number | null;
    messagesWithTask: number | null;
    sessionCounts: Array<{ owner: string; present: number; archived: number }>;
    sources: SourceScan[];
    /** Set when the store couldn't be read (rest of the store fields will be null/empty). */
    error?: string;
  };
}

const ENV_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_CONFIG_DIR",
  "GEMINI_CLI_HOME",
  "CLAUDE_DESKTOP_CACHE_DIR",
  "ARGUS_HOME",
  "ARGUS_DATA_DIR",
  "ARGUS_CONFIG_DIR",
  "ARGUS_PORT",
  "ARGUS_TASK_ENABLED",
  "ARGUS_TASK_PROVIDER",
  "ARGUS_TASK_MODEL",
  "NODE_ENV",
] as const;

function bunVersion(): string | undefined {
  return (globalThis as { Bun?: { version: string } }).Bun?.version;
}

function pathEntry(name: string, path: string | undefined): PathEntry {
  return { name, path: path ?? "(unset)", exists: !!path && existsSync(path) };
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** Gather the full debug payload. `serveReadOnly` is passed in by the caller (serve sets it true). */
export async function collectDebugInfo(opts: { serveReadOnly: boolean }): Promise<DebugInfo> {
  const config = loadConfig();
  const resolved = resolveTaskExtraction({}, config);

  const store: DebugInfo["store"] = {
    path: STORE_FILE,
    exists: existsSync(STORE_FILE),
    sizeBytes: sizeOf(STORE_FILE),
    schemaVersion: null,
    expectedSchemaVersion: STORE_SCHEMA_VERSION,
    sessions: null,
    messages: null,
    tasks: null,
    messagesWithTask: null,
    sessionCounts: [],
    sources: [],
  };

  try {
    const handle = await openStore();
    try {
      const stats = await handle.storeStats();
      store.schemaVersion = stats.schemaVersion;
      store.sessions = stats.sessions;
      store.messages = stats.messages;
      store.tasks = stats.tasks;
      store.messagesWithTask = stats.messagesWithTask;
      store.sessionCounts = await handle.resolvedSessionCounts();
      store.sources = await scanStore({ store: handle, sources: ALL_SOURCES });
    } finally {
      await handle.close();
    }
  } catch (err) {
    store.error = err instanceof Error ? err.message : String(err);
  }

  return {
    generatedAtMs: Date.now(),
    version: { argus: pkg.version, storeSchema: STORE_SCHEMA_VERSION },
    runtime: {
      runtime: bunVersion() ? `bun ${bunVersion()}` : `node ${process.version}`,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      cwd: process.cwd(),
      serveReadOnly: opts.serveReadOnly,
    },
    paths: [
      pathEntry("ARGUS_DATA_DIR", ARGUS_DATA_DIR),
      pathEntry("ARGUS_CONFIG_DIR", ARGUS_CONFIG_DIR),
      pathEntry("store (argus.db)", STORE_FILE),
      pathEntry("config (argus.json)", CONFIG_FILE),
      pathEntry("CLAUDE_DIR", CLAUDE_DIR),
      pathEntry("Claude projects", PROJECTS_DIR),
      pathEntry("Claude history", HISTORY_FILE),
      pathEntry("Claude settings", SETTINGS_FILE),
      pathEntry("CODEX_DIR", CODEX_DIR),
      pathEntry("Codex sessions", CODEX_SESSIONS_DIR),
      pathEntry("GEMINI_DIR", GEMINI_DIR),
      pathEntry("Cowork sessions", COWORK_SESSIONS_DIR),
      pathEntry("Claude chat cache", CLAUDE_CHAT_CACHE_DIR),
    ],
    env: ENV_VARS.map((name) => ({ name, value: process.env[name] ?? null })),
    config,
    taskExtraction: { enabled: resolved.enabled, provider: resolved.provider ?? "off", model: resolved.model },
    store,
  };
}
