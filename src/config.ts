// The `argus.json` config store — the config peer of the `argus.db` data store (#89).
//
// This file holds user *settings*, deliberately kept separate from secrets (`token.json`) and
// hand-authored price tables (`pricing.json`), which have different sensitivity/backup
// characteristics and stay as their own files. Keep this minimal and extensible: a typed shape, a
// tolerant loader, and one uniform resolver so precedence and the three naming conventions live in
// exactly one place.
//
// Every setting resolves through a single chain: CLI flag > env var > argus.json > built-in default.
// The three layers don't share a spelling — flags are kebab-case, env vars SCREAMING_SNAKE, and
// argus.json keys camelCase — and the names aren't mechanical transforms of each other (the enable
// toggle is `--extract-tasks` on the CLI but `taskExtraction.enabled` in the file). So each setting
// binds its three names explicitly via a descriptor; a generic case-converter won't do.
import { readFileSync } from "node:fs";
import { CONFIG_FILE } from "./paths.ts";
import {
  DEFAULT_TASK_EXTRACTION_PROVIDER,
  type TaskExtractionOptions,
  type TaskExtractionProvider,
} from "./indexing/interpret/task-extraction.ts";

/** The typed shape of `argus.json`. Designed to grow; task extraction is the first consumer. */
export interface ArgusConfig {
  taskExtraction?: {
    /** Opt-in index-time extraction (#88). Off by default — it's an LLM call per session. */
    enabled?: boolean;
    provider?: TaskExtractionProvider;
    model?: string;
    prompt?: string;
    promptFile?: string;
    command?: string;
  };
}

export type ConfigWarn = (message: string) => void;

/**
 * Read and parse `argus.json`. Missing file → `{}` (defaults, no error). Malformed JSON → a clear
 * warning and `{}` (never throws) — mirrors the tolerant handling of `pricing.json`.
 */
export function loadConfig(path: string = CONFIG_FILE, warn: ConfigWarn = console.warn): ArgusConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // missing/unreadable → defaults, silently
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ArgusConfig;
    warn(`Ignoring ${path}: expected a JSON object. Using defaults.`);
    return {};
  } catch (error) {
    warn(
      `Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}. Using defaults.`,
    );
    return {};
  }
}

/** Dotted camelCase lookup into the parsed config, e.g. getPath(cfg, "taskExtraction.provider"). */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** One setting, binding its three spellings explicitly plus coercion/validation and a default. */
export interface Setting<T> {
  /** argus.json location, dotted camelCase — e.g. "taskExtraction.provider". */
  path: string;
  /** env var, SCREAMING_SNAKE — e.g. "ARGUS_TASK_PROVIDER". */
  env?: string;
  /** citty flag, kebab-case — e.g. "task-provider". */
  flag?: string;
  default: T;
  /** Coerce a raw value (string from env/flag, typed from file) to T, validating as needed. */
  parse(raw: unknown): T;
}

/**
 * Resolve one setting through CLI flag > env var > argus.json > default. Any absent layer yields
 * undefined and falls through, so the same chain works for settings that don't populate every layer.
 */
/** A layer is "present" only when set to a non-empty value — so `ARGUS_TASK_PROVIDER=""` (an exported
 *  but blank env var) or a blank flag/file value falls through to the next layer rather than being
 *  parsed as a real setting. */
function present(value: unknown): boolean {
  return value != null && value !== "";
}

export function resolveSetting<T>(
  setting: Setting<T>,
  flags: Record<string, unknown>,
  file: ArgusConfig,
): T {
  const fromFlag = setting.flag ? flags[setting.flag] : undefined;
  if (present(fromFlag)) return setting.parse(fromFlag);
  const fromEnv = setting.env ? process.env[setting.env] : undefined;
  if (present(fromEnv)) return setting.parse(fromEnv);
  const fromFile = getPath(file, setting.path);
  if (present(fromFile)) return setting.parse(fromFile);
  return setting.default;
}

function parseBool(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

// Tolerant, like loadConfig: an invalid provider (a typo in argus.json or env) must not hard-exit an
// unrelated `index`/`serve`/`run` — warn and fall back to the default instead.
function parseProvider(raw: unknown): TaskExtractionProvider {
  const value = String(raw);
  if (value === "off" || value === "claude" || value === "command") return value;
  console.warn(
    `Ignoring invalid task extraction provider ${JSON.stringify(value)} (expected claude, command, or off); using "${DEFAULT_TASK_EXTRACTION_PROVIDER}".`,
  );
  return DEFAULT_TASK_EXTRACTION_PROVIDER as TaskExtractionProvider;
}

function parseString(raw: unknown): string {
  return String(raw);
}

/** The task-extraction settings, one descriptor per row of #89's setting map. */
const TASK_SETTINGS = {
  enabled: {
    path: "taskExtraction.enabled",
    env: "ARGUS_TASK_ENABLED",
    flag: "extract-tasks",
    default: false,
    parse: parseBool,
  } satisfies Setting<boolean>,
  provider: {
    path: "taskExtraction.provider",
    env: "ARGUS_TASK_PROVIDER",
    flag: "task-provider",
    default: DEFAULT_TASK_EXTRACTION_PROVIDER as TaskExtractionProvider,
    parse: parseProvider,
  } satisfies Setting<TaskExtractionProvider>,
  model: {
    path: "taskExtraction.model",
    env: "ARGUS_TASK_MODEL",
    flag: "task-model",
    default: undefined as string | undefined,
    parse: parseString,
  } satisfies Setting<string | undefined>,
  prompt: {
    path: "taskExtraction.prompt",
    env: "ARGUS_TASK_PROMPT",
    flag: "task-prompt",
    default: undefined as string | undefined,
    parse: parseString,
  } satisfies Setting<string | undefined>,
  promptFile: {
    path: "taskExtraction.promptFile",
    env: "ARGUS_TASK_PROMPT_FILE",
    flag: "task-prompt-file",
    default: undefined as string | undefined,
    parse: parseString,
  } satisfies Setting<string | undefined>,
  command: {
    path: "taskExtraction.command",
    env: "ARGUS_TASK_COMMAND",
    flag: "task-command",
    default: undefined as string | undefined,
    parse: parseString,
  } satisfies Setting<string | undefined>,
};

/** The opt-in toggle plus the provider settings, resolved through the uniform chain. */
export type ResolvedTaskExtraction = TaskExtractionOptions & { enabled: boolean };

/**
 * Resolve the effective task-extraction settings. `flags` is the citty-parsed args object (keys are
 * kebab-case flag names); pass `{}` for commands that don't expose the flags (e.g. `index` today).
 * `debugLog` is reattached after resolution since it isn't a persisted setting.
 */
export function resolveTaskExtraction(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
  debugLog?: (message: string) => void,
): ResolvedTaskExtraction {
  const resolved: ResolvedTaskExtraction = {
    enabled: resolveSetting(TASK_SETTINGS.enabled, flags, file),
    provider: resolveSetting(TASK_SETTINGS.provider, flags, file),
  };
  const model = resolveSetting(TASK_SETTINGS.model, flags, file);
  const prompt = resolveSetting(TASK_SETTINGS.prompt, flags, file);
  const promptFile = resolveSetting(TASK_SETTINGS.promptFile, flags, file);
  const command = resolveSetting(TASK_SETTINGS.command, flags, file);
  if (model) resolved.model = model;
  if (prompt) resolved.prompt = prompt;
  if (promptFile) resolved.promptFile = promptFile;
  if (command) resolved.command = command;
  if (debugLog) resolved.debugLog = debugLog;
  return resolved;
}
