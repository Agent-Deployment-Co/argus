// The `argus.json` config store — the config peer of the `argus.db` data store (#89).
//
// This file holds user *settings*, deliberately kept separate from secrets (the OS keychain /
// secrets.json, and token.json) and hand-authored price tables (`pricing.json`), which have different
// sensitivity/backup characteristics and stay as their own stores. Keep this minimal and extensible:
// a typed shape, a tolerant loader, and one uniform resolver so precedence and the three naming
// conventions live in exactly one place.
//
// Every setting resolves through a single chain: CLI flag > env var > argus.json > built-in default.
// The three layers don't share a spelling — flags are kebab-case, env vars SCREAMING_SNAKE, and
// argus.json keys camelCase — and the names aren't mechanical transforms of each other. So each
// setting binds its three names explicitly via a descriptor; a generic case-converter won't do.
//
// LLM access (#132) is a top-level `llm` block consumed by any model-driven feature. Task extraction
// is the first consumer: it references `llm.*` and may override `provider`/`model`/`command` under its
// own `taskExtraction.*` block (the historical keys, kept working with a deprecation note).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILE } from "./paths.ts";
import {
  defaultModelByProvider,
  getProvider,
  isLlmProvider,
  LLM_PROVIDERS,
  providersForConfigField,
  SELECTABLE_PROVIDERS,
} from "./llm/index.ts";
import type { LlmProvider, ResolvedLlmConfig } from "./llm/types.ts";

/** The task-extraction provider default, preserved from before the generalization: enabling task
 *  extraction with no provider configured uses the local `claude` CLI. */
const DEFAULT_TASK_PROVIDER: LlmProvider = "claude-cli";

/** Back-compat aliases for provider values that were released under older names, so existing
 *  argus.json / env values keep resolving without a warning. */
const PROVIDER_ALIASES: Record<string, LlmProvider> = { claude: "claude-cli" };

/** The typed shape of `argus.json`. Designed to grow; task extraction is the first LLM consumer. */
export interface ArgusConfig {
  /** Desktop app updates. Enabled by default so signed releases install automatically. */
  autoUpdate?: {
    enabled?: boolean;
    checkIntervalMinutes?: number;
  };
  /** General LLM access settings, shared by every model-driven feature (#132). */
  llm?: {
    provider?: LlmProvider;
    model?: string;
    /** OpenAI-compatible / self-hosted base URL (openai provider). */
    baseUrl?: string;
    /** Env var the API key is read from (also the secret-store key). Defaults per provider. */
    apiKeyEnv?: string;
    maxTokens?: number;
    /** Command line for the `command` provider. */
    command?: string;
  };
  taskExtraction?: {
    /** Opt-in index-time extraction (#88). Off by default — it's an LLM call per session. */
    enabled?: boolean;
    prompt?: string;
    promptFile?: string;
    /** @deprecated Per-consumer override of `llm.provider`. Prefer `llm.provider`. */
    provider?: LlmProvider;
    /** @deprecated Per-consumer override of `llm.model`. Prefer `llm.model`. */
    model?: string;
    /** @deprecated Per-consumer override of `llm.command`. Prefer `llm.command`. */
    command?: string;
  };
  hub?: {
    /** Argus Hub server URL, e.g. http://hub.internal:4242 */
    url?: string;
    /** Shared API key for Hub authentication */
    key?: string;
  };
  /** Keep prompt/response text in the local store so interpretation can read it without re-reading
   *  transcripts from disk (#120). Stored text is local-only — never uploaded by `sync`. On by
   *  default; set to false to keep session text out of `argus.db` entirely. */
  retainText?: boolean;
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

/** One option in a `select` control: the stored value plus its display label. An empty `value` is the
 *  "unset" choice (clears the setting so it falls back through env/default). */
export interface SelectOption {
  value: string;
  label: string;
}

/** An item in a select's option list: a real option, or a visual "separator" (rendered as a divider).
 *  The list is presented in the exact order given — pinned/special items first, then the rest. */
export type SelectItem = SelectOption | "separator";

/** How a setting is presented as an editable control in the web settings surface (#154). The control
 *  follows from the setting's type: boolean → toggle, fixed-choice → select, free number → number, the
 *  rest → text/textarea. UI-only metadata; the value contract still lives in `parse()`/`default`. */
export interface SettingUi {
  /** Human-facing field name, e.g. "Provider". */
  label: string;
  /** One-line explanation shown beside the control. */
  description?: string;
  control: "toggle" | "text" | "textarea" | "number" | "select";
  /** The full ordered option list for a `select` control, including the unset choice and any
   *  separators. Presented verbatim, so order it deliberately (see the UI ordering rules in CLAUDE.md). */
  options?: readonly SelectItem[];
  /** Gate: the control is inactive (disabled) unless the boolean setting at this path is on. E.g. the
   *  LLM fields are inactive until task extraction is enabled. */
  activeWhen?: { path: string };
  /** Gate: the control is hidden unless the (effective) value of the setting at `path` is one of `in`.
   *  E.g. a provider-specific field is shown only for the providers that use it. */
  visibleWhen?: { path: string; in: readonly string[] };
  /** The value this control resolves to when unset — used to evaluate `visibleWhen` against another
   *  field's effective value (e.g. an unset provider resolves to its default). */
  effectiveDefault?: string;
  /** A context-dependent placeholder shown when the field is blank: the placeholder is `values` keyed
   *  by the (effective) value of the setting at `path`. E.g. the Model field shows the selected
   *  provider's default model. Falls back to the generic placeholder when there's no entry. */
  placeholderByValue?: { path: string; values: Record<string, string> };
}

/** One setting, binding its three spellings explicitly plus coercion/validation and a default. */
export interface Setting<T> {
  /** argus.json location, dotted camelCase — e.g. "llm.provider". */
  path: string;
  /** env var, SCREAMING_SNAKE — e.g. "ARGUS_LLM_PROVIDER". */
  env?: string;
  /** citty flag, kebab-case — e.g. "llm-provider". */
  flag?: string;
  default: T;
  /** When true, `argus config list` redacts the value in human output to avoid leaking secrets. */
  secret?: boolean;
  /** Presentation metadata for the web settings surface (#154). Absent → not shown in the UI. */
  ui?: SettingUi;
  /** Coerce a raw value (string from env/flag, typed from file) to T, validating as needed. */
  parse(raw: unknown): T;
}

/** A layer is "present" only when set to a non-empty value — so `ARGUS_TASK_PROVIDER=""` (an exported
 *  but blank env var) or a blank flag/file value falls through to the next layer rather than being
 *  parsed as a real setting. */
export function present(value: unknown): boolean {
  return value != null && value !== "";
}

/**
 * Resolve one setting through CLI flag > env var > argus.json > default. Any absent layer yields
 * undefined and falls through, so the same chain works for settings that don't populate every layer.
 */
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

function parseString(raw: unknown): string {
  return String(raw);
}

const DEFAULT_AUTO_UPDATE_CHECK_INTERVAL_MINUTES = 60;

const HUB_SETTINGS = {
  url: {
    path: "hub.url",
    env: "ARGUS_HUB_URL",
    default: undefined as string | undefined,
    parse: parseString,
  } satisfies Setting<string | undefined>,
  key: {
    path: "hub.key",
    env: "ARGUS_HUB_KEY",
    default: undefined as string | undefined,
    secret: true,
    parse: parseString,
  } satisfies Setting<string | undefined>,
};

const AUTO_UPDATE_SETTINGS = {
  enabled: {
    path: "autoUpdate.enabled",
    env: "ARGUS_AUTO_UPDATE_ENABLED",
    default: true,
    parse: parseBool,
  } satisfies Setting<boolean>,
  checkIntervalMinutes: {
    path: "autoUpdate.checkIntervalMinutes",
    env: "ARGUS_AUTO_UPDATE_CHECK_INTERVAL_MINUTES",
    default: DEFAULT_AUTO_UPDATE_CHECK_INTERVAL_MINUTES,
    parse: (raw: unknown): number => {
      const n = Number(raw);
      return Number.isFinite(n) && n > 0
        ? Math.max(1, Math.floor(n))
        : DEFAULT_AUTO_UPDATE_CHECK_INTERVAL_MINUTES;
    },
  } satisfies Setting<number>,
};

const RETENTION_SETTINGS = {
  retainText: {
    path: "retainText",
    env: "ARGUS_RETAIN_TEXT",
    flag: "retain-text",
    default: true,
    parse: parseBool,
  } satisfies Setting<boolean>,
};

function parseNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// Tolerant, like loadConfig: an invalid provider (a typo in argus.json or env) must not hard-exit an
// unrelated `index`/`serve`/`run`. Warn and fall through (return undefined) so the next layer — and
// ultimately the consumer's default — applies.
function parseProvider(raw: unknown): LlmProvider | undefined {
  const value = String(raw);
  const aliased = PROVIDER_ALIASES[value] ?? value;
  if (isLlmProvider(aliased)) return aliased;
  console.warn(
    `Ignoring invalid LLM provider ${JSON.stringify(value)} (expected ${LLM_PROVIDERS.join(", ")}).`,
  );
  return undefined;
}

/** The standard env var (and secret-store key) for a provider's API key — from the provider registry. */
function defaultApiKeyEnv(provider: LlmProvider): string | undefined {
  return getProvider(provider)?.apiKeyEnv;
}

type OptionalString = string | undefined;
type OptionalProvider = LlmProvider | undefined;
type OptionalNumber = number | undefined;

/** The provider dropdown's option list. Pinned at the top: the unset choice (labeled with the default
 *  provider it resolves to) and an explicit "Off". Then a separator, then every selectable provider in
 *  alpha order (including claude-cli, excluding the special "off" which is pinned above). */
const PROVIDER_OPTIONS: SelectItem[] = [
  { value: "", label: `Default (${DEFAULT_TASK_PROVIDER})` },
  { value: "off", label: "Off" },
  "separator",
  ...SELECTABLE_PROVIDERS.filter((p) => p !== "off")
    .map((p) => p as string)
    .sort()
    .map((p) => ({ value: p, label: p })),
];

/** All `llm.*` settings are inactive until task extraction (their only consumer today) is enabled. */
const TASK_GATE = { path: "taskExtraction.enabled" } as const;

/** A provider-specific field is shown only for the providers that actually use it (from the registry),
 *  evaluated against the selected `llm.provider`. */
const visibleForField = (field: Parameters<typeof providersForConfigField>[0]) => ({
  path: "llm.provider",
  in: providersForConfigField(field) as readonly string[],
});

/** The shared `llm.*` settings. */
export const LLM_SETTINGS = {
  provider: {
    path: "llm.provider",
    env: "ARGUS_LLM_PROVIDER",
    flag: "llm-provider",
    default: undefined as OptionalProvider,
    ui: {
      label: "LLM Provider",
      description: "Which model backend Argus's AI features use.",
      control: "select",
      options: PROVIDER_OPTIONS,
      activeWhen: TASK_GATE,
      // An unset provider resolves to the default, so provider-specific fields show for it too.
      effectiveDefault: DEFAULT_TASK_PROVIDER,
    },
    parse: parseProvider,
  } satisfies Setting<OptionalProvider>,
  model: {
    path: "llm.model",
    env: "ARGUS_LLM_MODEL",
    flag: "llm-model",
    default: undefined as OptionalString,
    ui: {
      label: "Model",
      description: "Model name to request. Leave blank to use the provider's default.",
      control: "text",
      activeWhen: TASK_GATE,
      visibleWhen: visibleForField("model"),
      // Blank → show the selected provider's built-in default model as the placeholder.
      placeholderByValue: { path: "llm.provider", values: defaultModelByProvider() },
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  baseUrl: {
    path: "llm.baseUrl",
    env: "ARGUS_LLM_BASE_URL",
    flag: "llm-base-url",
    default: undefined as OptionalString,
    ui: {
      label: "Base URL",
      description: "OpenAI-compatible API endpoint, for the OpenAI provider or a self-hosted server.",
      control: "text",
      activeWhen: TASK_GATE,
      visibleWhen: visibleForField("baseUrl"),
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  apiKeyEnv: {
    path: "llm.apiKeyEnv",
    env: "ARGUS_LLM_API_KEY_ENV",
    flag: "llm-api-key-env",
    default: undefined as OptionalString,
    ui: {
      label: "API key variable",
      description: "Environment variable the API key is read from. Defaults per provider.",
      control: "text",
      activeWhen: TASK_GATE,
      visibleWhen: visibleForField("apiKeyEnv"),
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  maxTokens: {
    path: "llm.maxTokens",
    env: "ARGUS_LLM_MAX_TOKENS",
    flag: "llm-max-tokens",
    default: undefined as OptionalNumber,
    ui: {
      label: "Max output tokens",
      description: "Cap on the number of tokens generated per request.",
      control: "number",
      activeWhen: TASK_GATE,
      visibleWhen: visibleForField("maxTokens"),
    },
    parse: parseNumber,
  } satisfies Setting<OptionalNumber>,
  command: {
    path: "llm.command",
    env: "ARGUS_LLM_COMMAND",
    flag: "llm-command",
    default: undefined as OptionalString,
    ui: {
      label: "Command",
      description:
        'Command line to run for the "command" provider. The prompt is sent on stdin and the completion read from stdout.',
      control: "textarea",
      activeWhen: TASK_GATE,
      visibleWhen: visibleForField("command"),
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
};

/** Task-extraction settings: the opt-in toggle, the consumer-specific prompt, and the deprecated
 *  per-consumer overrides of provider/model/command (kept working; prefer `llm.*`). */
/** Default hourly ceiling for the background interpretation drain (#153). */
export const DEFAULT_MAX_SESSIONS_PER_HOUR = 30;

export const TASK_SETTINGS = {
  enabled: {
    path: "taskExtraction.enabled",
    env: "ARGUS_TASK_ENABLED",
    flag: "extract-tasks",
    default: false,
    ui: {
      label: "Extract tasks",
      description:
        "Run a model over each session at index time to segment and judge tasks. Off by default — it's a model call per session.",
      control: "toggle",
    },
    parse: parseBool,
  } satisfies Setting<boolean>,
  provider: {
    path: "taskExtraction.provider",
    env: "ARGUS_TASK_PROVIDER",
    flag: "task-provider",
    default: undefined as OptionalProvider,
    parse: parseProvider,
  } satisfies Setting<OptionalProvider>,
  model: {
    path: "taskExtraction.model",
    env: "ARGUS_TASK_MODEL",
    flag: "task-model",
    default: undefined as OptionalString,
    parse: parseString,
  } satisfies Setting<OptionalString>,
  prompt: {
    path: "taskExtraction.prompt",
    env: "ARGUS_TASK_PROMPT",
    flag: "task-prompt",
    default: undefined as OptionalString,
    ui: {
      label: "Custom prompt",
      description: "Override the built-in instructions. The session data is appended after it.",
      control: "textarea",
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  promptFile: {
    path: "taskExtraction.promptFile",
    env: "ARGUS_TASK_PROMPT_FILE",
    flag: "task-prompt-file",
    default: undefined as OptionalString,
    ui: {
      label: "Prompt file",
      description: "Read the custom instructions from this file. Takes precedence over the prompt above.",
      control: "text",
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  command: {
    path: "taskExtraction.command",
    env: "ARGUS_TASK_COMMAND",
    flag: "task-command",
    default: undefined as OptionalString,
    parse: parseString,
  } satisfies Setting<OptionalString>,
  // Throttle for the background interpretation drain (#153): the hourly ceiling on how many sessions
  // are interpreted automatically. The primary spend knob — predictable cost per hour regardless of how
  // often indexing wakes. The inline refresh path is not subject to it.
  maxSessionsPerHour: {
    path: "taskExtraction.maxSessionsPerHour",
    env: "ARGUS_TASK_MAX_PER_HOUR",
    flag: "task-max-per-hour",
    default: DEFAULT_MAX_SESSIONS_PER_HOUR as OptionalNumber,
    parse: parseNumber,
  } satisfies Setting<OptionalNumber>,
};

/** All known settings keyed by dotted argus.json path — used by `argus config get/set/list` and the
 *  web settings surface (#154). */
export const ALL_SETTINGS: Record<string, Setting<unknown>> = Object.fromEntries(
  [
    ...Object.values(LLM_SETTINGS),
    ...Object.values(TASK_SETTINGS),
    ...Object.values(HUB_SETTINGS),
    ...Object.values(AUTO_UPDATE_SETTINGS),
    ...Object.values(RETENTION_SETTINGS),
  ].map((s) => [s.path, s as Setting<unknown>]),
);

/**
 * Set a nested dotted path in `obj`, creating intermediate objects as needed. Mutates in place.
 * Typically called on the result of `loadConfig()` cast to `Record<string, unknown>`, then
 * passed to `writeConfig`.
 */
export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (cur[key] == null || typeof cur[key] !== "object" || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** Write `config` to `path` (default: `CONFIG_FILE`), creating the parent directory if needed. */
export function writeConfig(config: ArgusConfig, path: string = CONFIG_FILE): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Write `config` atomically: serialize to a sibling temp file, then `rename()` over the target so a
 * crash or kill mid-write can never leave a truncated/corrupt `argus.json` that breaks the next
 * startup (#154). `rename` is atomic within a filesystem, and the temp file is a sibling so it always
 * is. This is durability, not concurrency — the web server is the only writer.
 */
export function writeConfigAtomic(config: ArgusConfig, path: string = CONFIG_FILE): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.argus.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}


/**
 * Resolve the shared `llm.*` block into a `ResolvedLlmConfig`. `overrides` carries a consumer's own
 * provider/model/command (the per-consumer override layer): each wins over the shared `llm.*` value,
 * which wins over the built-in default. The API key itself is not resolved here (that's an async
 * secret-store read the consumer performs); `apiKeyEnv` names where to find it.
 */
function resolveLlmConfig(
  flags: Record<string, unknown>,
  file: ArgusConfig,
  overrides: { provider?: LlmProvider; model?: string; command?: string },
  defaultProvider: LlmProvider,
): ResolvedLlmConfig {
  const provider =
    overrides.provider ?? resolveSetting(LLM_SETTINGS.provider, flags, file) ?? defaultProvider;
  const model = overrides.model ?? resolveSetting(LLM_SETTINGS.model, flags, file);
  const command = overrides.command ?? resolveSetting(LLM_SETTINGS.command, flags, file);
  const baseUrl = resolveSetting(LLM_SETTINGS.baseUrl, flags, file);
  const maxTokens = resolveSetting(LLM_SETTINGS.maxTokens, flags, file);
  const apiKeyEnv = resolveSetting(LLM_SETTINGS.apiKeyEnv, flags, file) ?? defaultApiKeyEnv(provider);

  const llm: ResolvedLlmConfig = { provider };
  if (model) llm.model = model;
  if (baseUrl) llm.baseUrl = baseUrl;
  if (maxTokens != null) llm.maxTokens = maxTokens;
  if (command) llm.command = command;
  if (apiKeyEnv) llm.apiKeyEnv = apiKeyEnv;
  return llm;
}

/** The resolved task-extraction settings: the opt-in toggle, the LLM config it runs through, the
 *  consumer-specific prompt, and a transient debug sink (reattached after resolution). */
export interface ResolvedTaskExtraction {
  enabled: boolean;
  llm: ResolvedLlmConfig;
  /** Hourly ceiling for the throttled background drain (#153); always a positive number. */
  maxSessionsPerHour: number;
  /** Custom instruction prompt. The session data is appended after it. */
  prompt?: string;
  /** Read a custom instruction prompt from this file. Takes precedence over `prompt`. */
  promptFile?: string;
  /** Optional debug sink. Callers decide whether this goes to stdout/stderr. */
  debugLog?: (message: string) => void;
}

/**
 * Resolve the effective task-extraction settings. `flags` is the citty-parsed args object (keys are
 * kebab-case flag names); pass `{}` for commands that don't expose the flags. The deprecated
 * `taskExtraction.provider`/`model`/`command` keys resolve as the per-consumer override layer over the
 * shared `llm.*` block. `debugLog` is reattached after resolution since it isn't a persisted setting.
 */
export function resolveTaskExtraction(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
  debugLog?: (message: string) => void,
): ResolvedTaskExtraction {
  const overrides = {
    provider: resolveSetting(TASK_SETTINGS.provider, flags, file),
    model: resolveSetting(TASK_SETTINGS.model, flags, file),
    command: resolveSetting(TASK_SETTINGS.command, flags, file),
  };
  const llm = resolveLlmConfig(flags, file, overrides, DEFAULT_TASK_PROVIDER);

  const maxPerHour = resolveSetting(TASK_SETTINGS.maxSessionsPerHour, flags, file);
  const resolved: ResolvedTaskExtraction = {
    enabled: resolveSetting(TASK_SETTINGS.enabled, flags, file),
    llm,
    maxSessionsPerHour: maxPerHour != null && maxPerHour > 0 ? maxPerHour : DEFAULT_MAX_SESSIONS_PER_HOUR,
  };
  const prompt = resolveSetting(TASK_SETTINGS.prompt, flags, file);
  const promptFile = resolveSetting(TASK_SETTINGS.promptFile, flags, file);
  if (prompt) resolved.prompt = prompt;
  if (promptFile) resolved.promptFile = promptFile;
  if (debugLog) resolved.debugLog = debugLog;
  return resolved;
}

/** Automatic desktop update behavior. Defaults on. */
export function resolveAutoUpdateEnabled(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
): boolean {
  return resolveSetting(AUTO_UPDATE_SETTINGS.enabled, flags, file);
}

/** Minutes between desktop update checks. Defaults to 60. */
export function resolveAutoUpdateCheckIntervalMinutes(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
): number {
  return resolveSetting(AUTO_UPDATE_SETTINGS.checkIntervalMinutes, flags, file);
}

/** Whether to keep prompt/response text in the local store (#120). Defaults on; local-only. */
export function resolveRetainText(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
): boolean {
  return resolveSetting(RETENTION_SETTINGS.retainText, flags, file);
}

export interface ResolvedHubConfig {
  url: string;
  key: string;
}

/**
 * Resolve Hub connection settings from env > argus.json. Returns the config only when both
 * `hub.url` and `hub.key` are present; undefined otherwise.
 */
export function resolveHubConfig(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
): ResolvedHubConfig | undefined {
  const url = resolveSetting(HUB_SETTINGS.url, flags, file);
  const key = resolveSetting(HUB_SETTINGS.key, flags, file);
  if (url && key) return { url, key };
  return undefined;
}
