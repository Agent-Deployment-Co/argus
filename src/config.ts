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
import { ARGUS_LOG_LEVELS, logger, logWarn, normalizeLogLevel, type ArgusLogLevel, type Log } from "./logger.ts";

/** The default LLM provider, preserved from before the generalization: with no provider configured,
 *  model-driven features use the local `claude` CLI. The single source of truth for this default —
 *  `resolveActiveProvider` and the provider setting's `ui.effectiveDefault` both derive from it. */
export const DEFAULT_TASK_PROVIDER: LlmProvider = "claude-cli";

/** Back-compat aliases for provider values that were released under older names, so existing
 *  argus.json / env values keep resolving without a warning. */
const PROVIDER_ALIASES: Record<string, LlmProvider> = { claude: "claude-cli" };

/** One provider's own LLM settings (lives under `llm.providerConfigs[provider]`). Every field is the
 *  provider-scoped counterpart of an `llm.*` setting; which ones are meaningful depends on the provider
 *  (e.g. `command` for the command provider, `claudeCliPath` for claude-cli). */
export interface LlmProviderConfig {
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTokens?: number;
  /** Opaque provider-native reasoning-effort value (#234); passed through untranslated. */
  effort?: string;
  command?: string;
  claudeCliPath?: string;
}

/** The typed shape of `argus.json`. Designed to grow; task extraction is the first LLM consumer. */
export interface ArgusConfig {
  /** Desktop shell behavior. */
  desktop?: {
    /** Start the desktop app automatically when the user signs in. On by default. */
    startAtLogin?: boolean;
    /** Run the desktop app invisibly: no tray icon, no notifications, no first-run browser
     *  auto-open. Off by default. */
    silent?: boolean;
  };
  /** Desktop app updates. Enabled by default so signed releases install automatically. */
  autoUpdate?: {
    enabled?: boolean;
    checkIntervalMinutes?: number;
  };
  /** General LLM access settings, shared by every model-driven feature (#132). */
  llm?: {
    /** The active provider. Its own settings live under `providerConfigs[provider]`. */
    provider?: LlmProvider;
    /** Per-provider settings, so each provider keeps its own model/command/etc. and nothing goes
     *  stale when you switch providers. The active provider's block is what resolves. */
    providerConfigs?: Partial<Record<LlmProvider, LlmProviderConfig>>;
    // Legacy flat fields (pre-providerConfigs): still read as a fallback for the active provider, but
    // the UI now writes under `providerConfigs`. Kept so existing argus.json files keep working.
    model?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    maxTokens?: number;
    effort?: string;
    command?: string;
    claudeCliPath?: string;
  };
  /** The opt-in interpret stage (#234, formerly `taskExtraction`): title + summary + task segmentation
   *  + per-task outcome. `enabled` gates the whole stage. */
  sessionInterpretation?: {
    /** Index-time interpretation (#88). On by default. */
    enabled?: boolean;
    prompt?: string;
    promptFile?: string;
    maxSessionsPerHour?: number;
    /** Character limit for the generated title (#234). */
    titleMaxChars?: number;
    /** Character limit for the generated summary (#234). */
    summaryMaxChars?: number;
    /** @deprecated Per-consumer override of `llm.provider`. Prefer `llm.provider`. */
    provider?: LlmProvider;
    /** @deprecated Per-consumer override of `llm.model`. Prefer `llm.model`. */
    model?: string;
    /** @deprecated Per-consumer override of `llm.command`. Prefer `llm.command`. */
    command?: string;
  };
  /** @deprecated Renamed to `sessionInterpretation` (#234). Still read for one release; `loadConfig`
   *  callers that write config migrate it in place. */
  taskExtraction?: {
    enabled?: boolean;
    prompt?: string;
    promptFile?: string;
    maxSessionsPerHour?: number;
    provider?: LlmProvider;
    model?: string;
    command?: string;
  };
  hub?: {
    /** Argus Hub server URL, e.g. http://hub.internal:4242 */
    url?: string;
    /** Shared API key for Hub authentication */
    key?: string;
  };
  /** Terminal logging settings. */
  log?: {
    level?: ArgusLogLevel;
  };
  /** Keep prompt/response text in the local store so interpretation can read it without re-reading
   *  transcripts from disk (#120). Stored text is local-only — never uploaded by `sync`. On by
   *  default; set to false to keep session text out of `argus.db` entirely. */
  retainText?: boolean;
  /** App-persisted state: things Argus itself records about what's already happened (a completion
   *  marker, a dismissed prompt), as opposed to a user-editable preference. Never shown in the
   *  settings surface — there's no `ui` on these, so they never land in `EDITABLE`/`LAYOUT`. */
  state?: {
    /** Set once the user has dismissed the welcome modal (the "Don't show this again" checkbox),
     *  so it isn't shown again. Off by default (unset/false = not yet completed) — `argus serve
     *  --open` reads this to decide whether to append `?firstRun=1` to the URL it opens. */
    onboardingCompleted?: boolean;
  };
}

export type ConfigWarn = (message: string) => void;

function defaultConfigWarn(message: string): void {
  logWarn(logger, message);
}

/**
 * Read and parse `argus.json`. Missing file → `{}` (defaults, no error). Malformed JSON → a clear
 * warning and `{}` (never throws) — mirrors the tolerant handling of `pricing.json`.
 */
export function loadConfig(path: string = CONFIG_FILE, warn: ConfigWarn = defaultConfigWarn): ArgusConfig {
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
  /** For a `number` control: the minimum allowed value. Rendered as the input's `min`, and enforced on
   *  write (a smaller value is rejected). */
  min?: number;
  /** A server-computed placeholder source: the settings API fills the descriptor's `placeholder` from
   *  this when building the response (e.g. `"claudeBinary"` → the auto-resolved `claude` path). Keeps
   *  the API generic instead of special-casing a specific setting path. */
  placeholderFrom?: "claudeBinary";
}

/** One setting, binding its three spellings explicitly plus coercion/validation and a default. */
export interface Setting<T> {
  /** argus.json location, dotted camelCase — e.g. "llm.provider". */
  path: string;
  /** env var, SCREAMING_SNAKE — e.g. "ARGUS_LLM_PROVIDER". */
  env?: string;
  /** citty flag, kebab-case — e.g. "llm-provider". */
  flag?: string;
  /** A former argus.json location, still read (after `path`) for one release after a rename (#234).
   *  The in-place config migration rewrites the file so `path` becomes canonical. */
  legacyPath?: string;
  /** A former env var, still read (after `env`) for one release after a rename (#234). */
  legacyEnv?: string;
  /** A former citty flag, still read (after `flag`) for one release after a rename (#234). */
  legacyFlag?: string;
  default: T;
  /** When true, `argus config list` redacts the value in human output to avoid leaking secrets. */
  secret?: boolean;
  /** When true, the value is stored per-provider under `llm.providerConfigs[provider].<field>` (the
   *  field is `path` minus its `llm.` prefix) rather than at `path`, so each provider keeps its own.
   *  `path` is still the legacy flat fallback location. */
  providerScoped?: boolean;
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
  const fromLegacyFlag = setting.legacyFlag ? flags[setting.legacyFlag] : undefined;
  if (present(fromLegacyFlag)) return setting.parse(fromLegacyFlag);
  const fromEnv = setting.env ? process.env[setting.env] : undefined;
  if (present(fromEnv)) return setting.parse(fromEnv);
  const fromLegacyEnv = setting.legacyEnv ? process.env[setting.legacyEnv] : undefined;
  if (present(fromLegacyEnv)) return setting.parse(fromLegacyEnv);
  const fromFile = getPath(file, setting.path);
  if (present(fromFile)) return setting.parse(fromFile);
  const fromLegacyFile = setting.legacyPath ? getPath(file, setting.legacyPath) : undefined;
  if (present(fromLegacyFile)) return setting.parse(fromLegacyFile);
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

// Rejects (returns undefined) a present-but-invalid value, like parseProvider — so the settings API
// write path turns a bad value into a 400, and the resolver falls through to the default. `loadConfig`
// / `resolveLogLevel` stay tolerant: an invalid file/env value warns here, then resolves to the
// default rather than crashing.
function parseLogLevel(raw: unknown): ArgusLogLevel | undefined {
  const level = normalizeLogLevel(raw);
  if (level) return level;
  defaultConfigWarn(
    `Ignoring invalid log level ${JSON.stringify(String(raw))} (expected error, warn, info, debug, or trace).`,
  );
  return undefined;
}

const DEFAULT_AUTO_UPDATE_CHECK_INTERVAL_MINUTES = 60;

export const DESKTOP_SETTINGS = {
  startAtLogin: {
    path: "desktop.startAtLogin",
    env: "ARGUS_DESKTOP_START_AT_LOGIN",
    // Temporarily hard-disabled. The desktop app is signed with a personal Developer ID, so the OS
    // "runs in the background" notification and the Login Items entry show an individual's name
    // instead of the org's. Until the app is signed with an org certificate, start-at-login is off
    // for everyone: the desktop shell ignores this setting (see `desktop_start_at_login_enabled` in
    // desktop/src-tauri/src/lib.rs) and the Settings toggle is removed from the UI (src/api/settings.ts).
    // This descriptor is kept as restore-plumbing; re-enable by restoring both, then flipping this
    // default back to `true`.
    default: false,
    ui: {
      label: "Start when you sign in",
      description: "Open the desktop app automatically when you sign in to this computer.",
      control: "toggle",
    },
    parse: parseBool,
  } satisfies Setting<boolean>,
  // Run the desktop app invisibly: no tray icon, no notifications, no first-run browser auto-open.
  // Config-file-only (no `ui`): an operator-level switch, deliberately kept out of the Settings
  // screen — set it with `argus config set desktop.silent true`. The desktop shell reads it
  // directly and applies changes while running (see `silent_mode_enabled` in
  // desktop/src-tauri/src/lib.rs).
  silent: {
    path: "desktop.silent",
    env: "ARGUS_DESKTOP_SILENT",
    default: false,
    parse: parseBool,
  } satisfies Setting<boolean>,
};

export const HUB_SETTINGS = {
  url: {
    path: "hub.url",
    env: "ARGUS_HUB_URL",
    default: undefined as string | undefined,
    ui: {
      label: "Hub URL",
      description: "Argus Hub server to connect to, e.g. http://hub.internal:4242.",
      control: "text",
    },
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

export const AUTO_UPDATE_SETTINGS = {
  enabled: {
    path: "autoUpdate.enabled",
    env: "ARGUS_AUTO_UPDATE_ENABLED",
    default: true,
    ui: {
      label: "Install updates automatically",
      description:
        "Download and install new versions of the desktop app in the background. When off, you're notified an update is ready and can install it from the menu.",
      control: "toggle",
    },
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

/** App-persisted state (see `ArgusConfig.state`) — completion/dismissal markers Argus itself
 *  records, never a user-facing preference. No `ui` on any of these, so they never land in the
 *  settings surface's `EDITABLE`/`LAYOUT`. */
export const STATE_SETTINGS = {
  onboardingCompleted: {
    path: "state.onboardingCompleted",
    env: "ARGUS_STATE_ONBOARDING_COMPLETED",
    default: false,
    parse: parseBool,
  } satisfies Setting<boolean>,
};

const DEFAULT_LOG_LEVEL: ArgusLogLevel = "info";

/** The log-level select. Presented in the levels' natural order — least to most verbose
 *  (error → trace), which is `ARGUS_LOG_LEVELS` — not alphabetical, because verbosity is a meaningful
 *  ranking (see the UI ordering rules in CLAUDE.md). Pinned first is the unset choice, labeled with the
 *  default it resolves to. */
const LOG_LEVEL_OPTIONS: SelectItem[] = [
  { value: "", label: `Default (${DEFAULT_LOG_LEVEL})` },
  "separator",
  ...ARGUS_LOG_LEVELS.map((level) => ({ value: level, label: level })),
];

export const LOG_SETTINGS = {
  level: {
    path: "log.level",
    env: "ARGUS_LOG_LEVEL",
    flag: "log-level",
    default: DEFAULT_LOG_LEVEL,
    ui: {
      label: "Log level",
      description:
        "How much detail Argus prints to the terminal. The more verbose levels (debug, trace) help when diagnosing a problem.",
      control: "select",
      options: LOG_LEVEL_OPTIONS,
    },
    parse: parseLogLevel,
  } satisfies Setting<ArgusLogLevel | undefined>,
};

function parseNumber(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** A whole count of at least 1 — rejects 0, negatives, and non-numbers (returns undefined). Used for
 *  the hourly interpretation cap, where 0 would silently disable the drain. */
function parsePositiveInt(raw: unknown): number | undefined {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

// Tolerant, like loadConfig: an invalid provider (a typo in argus.json or env) must not hard-exit an
// unrelated `index`/`serve`/`run`. Warn and fall through (return undefined) so the next layer — and
// ultimately the consumer's default — applies.
function parseProvider(raw: unknown): LlmProvider | undefined {
  const value = String(raw);
  const aliased = PROVIDER_ALIASES[value] ?? value;
  if (isLlmProvider(aliased)) return aliased;
  defaultConfigWarn(
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
 *  provider it resolves to). Then a separator, then every selectable provider in alpha order. There's
 *  no "Off" choice — the Extract-tasks toggle is the on/off, so an "off" provider while extraction is on
 *  would be contradictory ("off" stays a valid CLI/config value, just not offered here). */
const PROVIDER_OPTIONS: SelectItem[] = [
  { value: "", label: `Default (${DEFAULT_TASK_PROVIDER})` },
  "separator",
  ...SELECTABLE_PROVIDERS.filter((p) => p !== "off")
    .map((p) => p as string)
    .sort()
    .map((p) => ({ value: p, label: p })),
];

/** All `llm.*` settings are inactive until session interpretation (their only consumer today) is
 *  enabled. */
const INTERPRETATION_GATE = { path: "sessionInterpretation.enabled" } as const;

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
      activeWhen: INTERPRETATION_GATE,
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
    providerScoped: true,
    ui: {
      label: "Model",
      description: "Model name to request. Leave blank to use the provider's default.",
      control: "text",
      activeWhen: INTERPRETATION_GATE,
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
    providerScoped: true,
    ui: {
      label: "Base URL",
      description: "OpenAI-compatible API endpoint, for the OpenAI provider or a self-hosted server.",
      control: "text",
      activeWhen: INTERPRETATION_GATE,
      visibleWhen: visibleForField("baseUrl"),
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  apiKeyEnv: {
    path: "llm.apiKeyEnv",
    env: "ARGUS_LLM_API_KEY_ENV",
    flag: "llm-api-key-env",
    default: undefined as OptionalString,
    providerScoped: true,
    ui: {
      label: "API key variable",
      description: "Environment variable the API key is read from. Defaults per provider.",
      control: "text",
      activeWhen: INTERPRETATION_GATE,
      visibleWhen: visibleForField("apiKeyEnv"),
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  maxTokens: {
    path: "llm.maxTokens",
    env: "ARGUS_LLM_MAX_TOKENS",
    flag: "llm-max-tokens",
    default: undefined as OptionalNumber,
    providerScoped: true,
    ui: {
      label: "Max output tokens",
      description: "Cap on the number of tokens generated per request.",
      control: "number",
      activeWhen: INTERPRETATION_GATE,
      visibleWhen: visibleForField("maxTokens"),
    },
    parse: parseNumber,
  } satisfies Setting<OptionalNumber>,
  // Opaque, provider-native reasoning-effort passthrough (#234). Not translated — the value is
  // whatever the configured provider expects (e.g. low/medium/high for claude/OpenAI). Blank →
  // omitted entirely, which the cheap default models require (haiku rejects an effort parameter).
  effort: {
    path: "llm.effort",
    env: "ARGUS_LLM_EFFORT",
    flag: "llm-effort",
    default: undefined as OptionalString,
    providerScoped: true,
    ui: {
      label: "Reasoning effort",
      description:
        "Reasoning-effort level passed to the model (provider-specific, not supported by all models). Leave blank for the provider default.",
      control: "text",
      activeWhen: INTERPRETATION_GATE,
      visibleWhen: visibleForField("effort"),
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  command: {
    path: "llm.command",
    env: "ARGUS_LLM_COMMAND",
    flag: "llm-command",
    default: undefined as OptionalString,
    providerScoped: true,
    ui: {
      label: "Command",
      description:
        'Command line to run for the "command" provider. The prompt is sent on stdin and the completion read from stdout.',
      control: "textarea",
      activeWhen: INTERPRETATION_GATE,
      visibleWhen: visibleForField("command"),
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  // An explicit path to the `claude` binary, for when it can't be auto-resolved — e.g. a GUI-launched
  // app's minimal PATH (#159). Normally unset; the claude-cli provider auto-resolves the binary
  // (PATH → login shell → known locations), and the UI shows that resolved path as the placeholder.
  claudeCliPath: {
    path: "llm.claudeCliPath",
    env: "ARGUS_CLAUDE_CLI_PATH",
    flag: "claude-cli-path",
    default: undefined as OptionalString,
    providerScoped: true,
    ui: {
      label: "Claude CLI path",
      description: "Full path to the claude binary. Leave blank to auto-detect.",
      control: "text",
      activeWhen: INTERPRETATION_GATE,
      visibleWhen: visibleForField("claudeCliPath"),
      placeholderFrom: "claudeBinary",
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
};

/** Session-interpretation settings (#234, formerly `taskExtraction`): the opt-in toggle, the
 *  consumer-specific prompt, the title/summary character limits, and the deprecated per-consumer
 *  overrides of provider/model/command (kept working; prefer `llm.*`). Each setting reads its former
 *  `taskExtraction.*` path / `ARGUS_TASK_*` env as a legacy fallback for one release. */
/** Default hourly ceiling for the background interpretation drain (#153). */
export const DEFAULT_MAX_SESSIONS_PER_HOUR = 30;
/** Default character limits for the generated title/summary (#234). */
export const DEFAULT_TITLE_MAX_CHARS = 100;
export const DEFAULT_SUMMARY_MAX_CHARS = 500;

export const SESSION_INTERPRETATION_SETTINGS = {
  enabled: {
    path: "sessionInterpretation.enabled",
    env: "ARGUS_INTERPRET_ENABLED",
    flag: "interpret",
    legacyPath: "taskExtraction.enabled",
    legacyEnv: "ARGUS_TASK_ENABLED",
    legacyFlag: "extract-tasks",
    default: true,
    ui: {
      label: "Interpret sessions",
      description:
        "Use AI to interpret each session — generating a title and summary, segmenting tasks, and judging outcomes. Relatively lightweight, but it consumes tokens with the configured LLM provider.",
      control: "toggle",
    },
    parse: parseBool,
  } satisfies Setting<boolean>,
  provider: {
    path: "sessionInterpretation.provider",
    env: "ARGUS_INTERPRET_PROVIDER",
    flag: "interpret-provider",
    legacyPath: "taskExtraction.provider",
    legacyEnv: "ARGUS_TASK_PROVIDER",
    legacyFlag: "task-provider",
    default: undefined as OptionalProvider,
    parse: parseProvider,
  } satisfies Setting<OptionalProvider>,
  model: {
    path: "sessionInterpretation.model",
    env: "ARGUS_INTERPRET_MODEL",
    flag: "interpret-model",
    legacyPath: "taskExtraction.model",
    legacyEnv: "ARGUS_TASK_MODEL",
    legacyFlag: "task-model",
    default: undefined as OptionalString,
    parse: parseString,
  } satisfies Setting<OptionalString>,
  prompt: {
    path: "sessionInterpretation.prompt",
    env: "ARGUS_INTERPRET_PROMPT",
    flag: "interpret-prompt",
    legacyPath: "taskExtraction.prompt",
    legacyEnv: "ARGUS_TASK_PROMPT",
    legacyFlag: "task-prompt",
    default: undefined as OptionalString,
    ui: {
      label: "Custom prompt",
      description: "Override the built-in instructions. The session data is appended after it.",
      control: "textarea",
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  promptFile: {
    path: "sessionInterpretation.promptFile",
    env: "ARGUS_INTERPRET_PROMPT_FILE",
    flag: "interpret-prompt-file",
    legacyPath: "taskExtraction.promptFile",
    legacyEnv: "ARGUS_TASK_PROMPT_FILE",
    legacyFlag: "task-prompt-file",
    default: undefined as OptionalString,
    ui: {
      label: "Prompt file",
      description: "Read the custom instructions from this file. Takes precedence over the prompt above.",
      control: "text",
    },
    parse: parseString,
  } satisfies Setting<OptionalString>,
  command: {
    path: "sessionInterpretation.command",
    env: "ARGUS_INTERPRET_COMMAND",
    flag: "interpret-command",
    legacyPath: "taskExtraction.command",
    legacyEnv: "ARGUS_TASK_COMMAND",
    legacyFlag: "task-command",
    default: undefined as OptionalString,
    parse: parseString,
  } satisfies Setting<OptionalString>,
  // Throttle for the background interpretation drain (#153): the hourly ceiling on how many sessions
  // are interpreted automatically. The primary spend knob — predictable cost per hour regardless of how
  // often indexing wakes. The inline refresh path is not subject to it.
  maxSessionsPerHour: {
    path: "sessionInterpretation.maxSessionsPerHour",
    env: "ARGUS_INTERPRET_MAX_PER_HOUR",
    flag: "interpret-max-per-hour",
    legacyPath: "taskExtraction.maxSessionsPerHour",
    legacyEnv: "ARGUS_TASK_MAX_PER_HOUR",
    legacyFlag: "task-max-per-hour",
    default: DEFAULT_MAX_SESSIONS_PER_HOUR as OptionalNumber,
    ui: {
      label: "Max sessions per hour",
      description:
        "Cap on how many sessions are interpreted automatically each hour. Refreshing a session manually isn't limited.",
      control: "number",
      activeWhen: INTERPRETATION_GATE,
      min: 1,
    },
    parse: parsePositiveInt,
  } satisfies Setting<OptionalNumber>,
  // Character limits for the generated title/summary (#234). Stated in the pass-1 prompt as
  // constraints and clamped defensively on write in case the model overruns.
  // Config-file-only (no `ui`): too fiddgy to expose in the settings screen, so these resolve from
  // argus.json / env / flag only (like `retainText`). They still register in ALL_SETTINGS for
  // `argus config get/set`.
  titleMaxChars: {
    path: "sessionInterpretation.titleMaxChars",
    env: "ARGUS_INTERPRET_TITLE_MAX_CHARS",
    flag: "interpret-title-max-chars",
    default: DEFAULT_TITLE_MAX_CHARS as OptionalNumber,
    parse: parsePositiveInt,
  } satisfies Setting<OptionalNumber>,
  summaryMaxChars: {
    path: "sessionInterpretation.summaryMaxChars",
    env: "ARGUS_INTERPRET_SUMMARY_MAX_CHARS",
    flag: "interpret-summary-max-chars",
    default: DEFAULT_SUMMARY_MAX_CHARS as OptionalNumber,
    parse: parsePositiveInt,
  } satisfies Setting<OptionalNumber>,
};

/** All known settings keyed by dotted argus.json path — used by `argus config get/set/list` and the
 *  web settings surface (#154). */
export const ALL_SETTINGS: Record<string, Setting<unknown>> = Object.fromEntries(
  [
    ...Object.values(LLM_SETTINGS),
    ...Object.values(SESSION_INTERPRETATION_SETTINGS),
    ...Object.values(DESKTOP_SETTINGS),
    ...Object.values(HUB_SETTINGS),
    ...Object.values(AUTO_UPDATE_SETTINGS),
    ...Object.values(RETENTION_SETTINGS),
    ...Object.values(LOG_SETTINGS),
    ...Object.values(STATE_SETTINGS),
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
let atomicWriteSeq = 0;

export function writeConfigAtomic(config: ArgusConfig, path: string = CONFIG_FILE): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Unique per call (pid + a process-local counter), not just per pid: under `argus run` two legs in
  // the same process (the server and the sync watcher's hub-key migration) can write concurrently, and
  // a shared temp path would let one's rename() hit the other's already-renamed file → ENOENT crash.
  const tmp = join(dir, `.argus.json.${process.pid}.${atomicWriteSeq++}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}


/**
 * Resolve the shared `llm.*` block into a `ResolvedLlmConfig`. `overrides` carries a consumer's own
 * provider/model/command (the per-consumer override layer): each wins over the shared `llm.*` value,
 * which wins over the built-in default. The API key itself is not resolved here (that's an async
 * secret-store read the consumer performs); `apiKeyEnv` names where to find it.
 */
/** The bare field name of a provider-scoped `llm.*` setting (`llm.model` → `model`). */
export function llmFieldName(setting: Setting<unknown>): string {
  return setting.path.slice("llm.".length);
}

/** Dotted path to a provider-scoped field's stored value: `llm.providerConfigs.<provider>.<field>`. */
export function providerConfigPath(provider: string, field: string): string {
  return `llm.providerConfigs.${provider}.${field}`;
}

/**
 * Resolve a provider-scoped `llm.*` setting for the active provider:
 *   flag > env > `llm.providerConfigs[provider].<field>` > legacy flat `llm.<field>` > default.
 * The flag/env layers stay global overrides of whichever provider is active; the legacy flat value is
 * the pre-`providerConfigs` location, kept so existing argus.json files keep resolving.
 */
export function resolveProviderScoped<T>(
  setting: Setting<T>,
  flags: Record<string, unknown>,
  file: ArgusConfig,
  provider: string,
): T {
  const fromFlag = setting.flag ? flags[setting.flag] : undefined;
  if (present(fromFlag)) return setting.parse(fromFlag);
  const fromEnv = setting.env ? process.env[setting.env] : undefined;
  if (present(fromEnv)) return setting.parse(fromEnv);
  const scoped = getPath(file, providerConfigPath(provider, llmFieldName(setting)));
  if (present(scoped)) return setting.parse(scoped);
  const legacy = getPath(file, setting.path);
  if (present(legacy)) return setting.parse(legacy);
  return setting.default;
}

/** The active LLM provider: `llm.provider` (flag > env > file), or the built-in default when unset.
 *  The one place the "what provider is in effect" question is answered. */
export function resolveActiveProvider(
  file: ArgusConfig = loadConfig(),
  flags: Record<string, unknown> = {},
): LlmProvider {
  return resolveSetting(LLM_SETTINGS.provider, flags, file) ?? DEFAULT_TASK_PROVIDER;
}

/**
 * One-time, idempotent migration: relocate any legacy flat `llm.<field>` values (model, apiKeyEnv,
 * command, …) into `llm.providerConfigs[<configured provider>].<field>`, then drop the flat keys.
 *
 * Pre-`providerConfigs` those fields lived flat and applied to whatever provider was active. The scoped
 * resolver still reads them as a fallback for *any* active provider (`resolveProviderScoped`), so once
 * the user switches providers the new provider inherits the old one's model/key-env (#154 review). We
 * fold them under the provider they were written for — the file's persisted `llm.provider`, NOT the
 * env-resolved active provider (an env override is a runtime choice, not what the flat values describe)
 * — so each provider keeps its own values and the cross-provider bleed stops. A no-op (no write) when
 * there are no flat values. An already-scoped value wins (never clobbered). Returns true if it moved
 * anything. Called on serve start, mirroring the Hub-key migration.
 */
export function migrateLlmFlatToProviderConfigs(
  configPath: string = CONFIG_FILE,
  // Optional pre-loaded config so the caller can run both startup migrations off a single disk read;
  // both mutate this same object and each writes the cumulative state, so order can't clobber.
  file: ArgusConfig & Record<string, unknown> = loadConfig(configPath) as ArgusConfig & Record<string, unknown>,
): boolean {
  const scoped = Object.values(LLM_SETTINGS).filter((s) => (s as Setting<unknown>).providerScoped) as Setting<unknown>[];
  const flat = scoped.filter((s) => present(getPath(file, s.path)));
  if (!flat.length) return false;
  const provider = parseProvider(getPath(file, "llm.provider")) ?? DEFAULT_TASK_PROVIDER;
  for (const s of flat) {
    const dest = providerConfigPath(provider, llmFieldName(s));
    if (!present(getPath(file, dest))) setPath(file, dest, getPath(file, s.path)); // scoped value wins
    setPath(file, s.path, undefined); // drop the flat key (JSON.stringify omits undefined)
  }
  writeConfigAtomic(file, configPath);
  return true;
}

/**
 * One-time, idempotent migration (#234): relocate a legacy `taskExtraction.*` block to
 * `sessionInterpretation.*`, then drop the legacy block. Fields already present under the new key win
 * (never clobbered). A no-op (no write) when there's no legacy block. Returns true if it moved
 * anything. Called on serve start alongside `migrateLlmFlatToProviderConfigs`. Read paths that don't
 * persist config still resolve the legacy keys via each setting's `legacyPath`/`legacyEnv`, so this is
 * about making the new key canonical on disk, not about correctness of resolution.
 */
export function migrateTaskExtractionToSessionInterpretation(
  configPath: string = CONFIG_FILE,
  // Optional pre-loaded config (see migrateLlmFlatToProviderConfigs) so serve start reads argus.json once.
  file: ArgusConfig & Record<string, unknown> = loadConfig(configPath) as ArgusConfig & Record<string, unknown>,
): boolean {
  const legacy = getPath(file, "taskExtraction");
  if (legacy == null || typeof legacy !== "object" || Array.isArray(legacy)) return false;
  const current = getPath(file, "sessionInterpretation");
  const currentObj =
    current != null && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  // New-key values win over legacy ones on conflict.
  setPath(file, "sessionInterpretation", { ...(legacy as Record<string, unknown>), ...currentObj });
  setPath(file, "taskExtraction", undefined); // drop the legacy block (JSON.stringify omits undefined)
  writeConfigAtomic(file, configPath);
  return true;
}

function resolveLlmConfig(
  flags: Record<string, unknown>,
  file: ArgusConfig,
  overrides: { provider?: LlmProvider; model?: string; command?: string },
): ResolvedLlmConfig {
  const provider = overrides.provider ?? resolveActiveProvider(file, flags);
  // Provider-scoped fields resolve against the active provider's own block, so switching providers
  // never picks up another provider's model/command/etc.
  const model = overrides.model ?? resolveProviderScoped(LLM_SETTINGS.model, flags, file, provider);
  const command = overrides.command ?? resolveProviderScoped(LLM_SETTINGS.command, flags, file, provider);
  const baseUrl = resolveProviderScoped(LLM_SETTINGS.baseUrl, flags, file, provider);
  const maxTokens = resolveProviderScoped(LLM_SETTINGS.maxTokens, flags, file, provider);
  const effort = resolveProviderScoped(LLM_SETTINGS.effort, flags, file, provider);
  const apiKeyEnv = resolveProviderScoped(LLM_SETTINGS.apiKeyEnv, flags, file, provider) ?? defaultApiKeyEnv(provider);
  const claudeCliPath = resolveProviderScoped(LLM_SETTINGS.claudeCliPath, flags, file, provider);

  const llm: ResolvedLlmConfig = { provider };
  if (model) llm.model = model;
  if (baseUrl) llm.baseUrl = baseUrl;
  if (maxTokens != null) llm.maxTokens = maxTokens;
  if (effort) llm.effort = effort;
  if (command) llm.command = command;
  if (apiKeyEnv) llm.apiKeyEnv = apiKeyEnv;
  if (claudeCliPath) llm.claudeCliPath = claudeCliPath;
  return llm;
}

/** The resolved session-interpretation settings: the opt-in toggle, the LLM config it runs through,
 *  the consumer-specific prompt, the title/summary character limits, and a transient debug sink
 *  (reattached after resolution). */
export interface ResolvedSessionInterpretation {
  enabled: boolean;
  llm: ResolvedLlmConfig;
  /** Hourly ceiling for the throttled background drain (#153); always a positive number. */
  maxSessionsPerHour: number;
  /** Character limit for the generated title (#234); always a positive number. */
  titleMaxChars: number;
  /** Character limit for the generated summary (#234); always a positive number. */
  summaryMaxChars: number;
  /** Custom instruction prompt. The session data is appended after it. */
  prompt?: string;
  /** Read a custom instruction prompt from this file. Takes precedence over `prompt`. */
  promptFile?: string;
  /** Optional logger for interpretation debug messages. */
  log?: Log;
}

/**
 * Resolve the effective session-interpretation settings. `flags` is the citty-parsed args object (keys
 * are kebab-case flag names); pass `{}` for commands that don't expose the flags. The deprecated
 * `sessionInterpretation.provider`/`model`/`command` keys (and their legacy `taskExtraction.*`
 * fallbacks) resolve as the per-consumer override layer over the shared `llm.*` block. `log` is
 * reattached after resolution since it isn't a persisted setting.
 */
export function resolveSessionInterpretation(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
  log?: Log,
): ResolvedSessionInterpretation {
  const overrides = {
    provider: resolveSetting(SESSION_INTERPRETATION_SETTINGS.provider, flags, file),
    model: resolveSetting(SESSION_INTERPRETATION_SETTINGS.model, flags, file),
    command: resolveSetting(SESSION_INTERPRETATION_SETTINGS.command, flags, file),
  };
  const llm = resolveLlmConfig(flags, file, overrides);

  const maxPerHour = resolveSetting(SESSION_INTERPRETATION_SETTINGS.maxSessionsPerHour, flags, file);
  const titleMaxChars = resolveSetting(SESSION_INTERPRETATION_SETTINGS.titleMaxChars, flags, file);
  const summaryMaxChars = resolveSetting(SESSION_INTERPRETATION_SETTINGS.summaryMaxChars, flags, file);
  const resolved: ResolvedSessionInterpretation = {
    enabled: resolveSetting(SESSION_INTERPRETATION_SETTINGS.enabled, flags, file),
    llm,
    maxSessionsPerHour: maxPerHour != null && maxPerHour > 0 ? maxPerHour : DEFAULT_MAX_SESSIONS_PER_HOUR,
    titleMaxChars: titleMaxChars != null && titleMaxChars > 0 ? titleMaxChars : DEFAULT_TITLE_MAX_CHARS,
    summaryMaxChars: summaryMaxChars != null && summaryMaxChars > 0 ? summaryMaxChars : DEFAULT_SUMMARY_MAX_CHARS,
  };
  const prompt = resolveSetting(SESSION_INTERPRETATION_SETTINGS.prompt, flags, file);
  const promptFile = resolveSetting(SESSION_INTERPRETATION_SETTINGS.promptFile, flags, file);
  if (prompt) resolved.prompt = prompt;
  if (promptFile) resolved.promptFile = promptFile;
  if (log) resolved.log = log;
  return resolved;
}

/** Resolve terminal log verbosity. `--log-level` is explicit; `--quiet`, `--verbose`, and the legacy
 *  task-extraction `--debug` flag are command-line shorthands above env and file settings. */
export function resolveLogLevel(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
): ArgusLogLevel {
  if (flags["log-level"] != null && flags["log-level"] !== "")
    return parseLogLevel(flags["log-level"]) ?? DEFAULT_LOG_LEVEL;
  if (flags.quiet === true) return "warn";
  if (flags.verbose === true || flags.debug === true) return "debug";
  return resolveSetting(LOG_SETTINGS.level, {}, file) ?? DEFAULT_LOG_LEVEL;
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

/** Whether the desktop app starts when the user signs in. Defaults on. */
export function resolveDesktopStartAtLogin(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
): boolean {
  return resolveSetting(DESKTOP_SETTINGS.startAtLogin, flags, file);
}

/** Whether to keep prompt/response text in the local store (#120). Defaults on; local-only. */
export function resolveRetainText(
  flags: Record<string, unknown> = {},
  file: ArgusConfig = loadConfig(),
): boolean {
  return resolveSetting(RETENTION_SETTINGS.retainText, flags, file);
}

// Resolving the Hub connection needs the secret store (the Hub key lives in the OS keychain, like the
// LLM API keys), so `resolveHubConfig` lives in `secrets.ts` — this module stays pure of secret access.
// `hub.url` is resolved there via `resolveSetting(HUB_SETTINGS.url, …)`; the key comes from the store.
