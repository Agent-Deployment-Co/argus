// The settings surface behind GET/PUT /api/settings (#154): a registry-driven view of everything
// settable in `argus.json`, plus a validated, atomic single-setting write. Everything here derives
// from the settings registry in `config.ts` (each setting binds its names, `parse()`, default, and
// UI metadata), so the web surface stays in sync with the config surface rather than hand-listing
// fields. This module only *groups* and *serializes* — the value contract stays in `config.ts`.
import {
  AUTO_UPDATE_SETTINGS,
  getPath,
  HUB_SETTINGS,
  llmFieldName,
  loadConfig,
  LLM_SETTINGS,
  LOG_SETTINGS,
  present,
  resolveActiveProvider,
  resolveSetting,
  resolveTaskExtraction,
  setPath,
  TASK_SETTINGS,
  writeConfigAtomic,
  type ArgusConfig,
  type SelectOption,
  type Setting,
  type SettingUi,
} from "../config.ts";
import { complete, getProvider, providersForConfigField } from "../llm/index.ts";
import type { ResolvedLlmConfig } from "../llm/types.ts";
import { claudeProviderArgs } from "../llm/providers/local.ts";
import { resolveApiKey, type SecretStore } from "../secrets.ts";
import { CONFIG_FILE } from "../paths.ts";
import { logAt, logDebug, type Log } from "../logger.ts";

/** Where an effective value is coming from when it isn't the `argus.json` layer the UI edits — so the
 *  surface can warn that a file edit won't take effect (an env var/flag is winning). */
export interface SettingOverride {
  layer: "env" | "flag";
  /** The overriding name, e.g. the env var "ARGUS_LLM_PROVIDER". */
  name: string;
}

/** One setting as the web surface sees it: its identity + UI metadata, the value currently in
 *  `argus.json` (the layer the UI edits), the effective value after the resolver, and any override. */
export interface SettingDescriptor {
  path: string;
  ui: SettingUi;
  /** Marked secret in the registry — the surface should treat the value as sensitive. */
  secret: boolean;
  /** Value held in `argus.json` (the editable layer), or null when the file doesn't set it. */
  fileValue: unknown;
  /** Effective value after flag > env > file > default. May differ from `fileValue` when overridden. */
  effectiveValue: unknown;
  /** Present when the effective value comes from a higher-precedence layer than the file. */
  override?: SettingOverride;
  /** A server-computed placeholder hint shown when the field is empty (e.g. the auto-resolved
   *  `claude` binary path for `llm.claudeCliPath`). */
  placeholder?: string;
  /** When true, the value is stored per active provider under `llm.providerConfigs[provider]`. The UI
   *  reads/writes it against the *selected* provider using `field` (see the response's `providerConfigs`),
   *  rather than a single value on this descriptor; `path` is the field's logical (flat) identity. */
  providerScoped?: boolean;
  /** For a provider-scoped field, the bare field name (`llm.model` → `model`) the UI uses to build the
   *  per-provider read/write key. Server-supplied so the client never re-derives the path scheme. */
  field?: string;
}

/** A secret-backed field in the surface (#132): the value is written/read through the
 *  `/api/settings/secrets/:name` endpoints (masked status only, never the raw value), so it's treated
 *  like a password — never `argus.json`. Two shapes:
 *   - Fixed (`secretName`): one secret regardless of any other field — e.g. the Argus Hub key.
 *   - Provider-keyed (`secretNames` + `providerPath`): the target secret depends on another field's
 *     value (the LLM API key, whose name depends on the selected provider); shown only for the
 *     values present in the map.
 *  Either way it renders beneath the setting at `providerPath` (the anchor). */
export interface SecretFieldDescriptor {
  /** Stable id for the UI (not a stored argus.json path). */
  key: string;
  label: string;
  description?: string;
  /** Gate: inactive unless the boolean setting at this path is on (e.g. task extraction). */
  activeWhen?: { path: string };
  /** The setting this field renders beneath. For the provider-keyed shape, its value also selects
   *  which secret name to use. */
  providerPath: string;
  /** Fixed secret name (env var), when the field maps to exactly one secret. */
  secretName?: string;
  /** anchor value → the secret name (env var). The field is shown only for the values present here. */
  secretNames?: Record<string, string>;
}

/** A "Test connection" action for a section — runs a tiny live completion through the configured
 *  provider so the user can confirm their setup works. */
export interface ConnectionTestDescriptor {
  /** Gate: the action is disabled unless the boolean setting at this path is on (task extraction). */
  activeWhen?: { path: string };
}

/** A labeled group of settings within a category (the right-pane sub-sections). */
export interface SettingsSection {
  label?: string;
  settings: SettingDescriptor[];
  /** Secret-store-backed fields (e.g. the API key), rendered after the plain settings. */
  secretFields?: SecretFieldDescriptor[];
  /** When set, the section offers a "Test connection" button. */
  connectionTest?: ConnectionTestDescriptor;
}

/** A left-nav category and its sectioned settings. */
export interface SettingsCategory {
  id: string;
  label: string;
  sections: SettingsSection[];
}

export interface SettingsResponse {
  categories: SettingsCategory[];
  /** Stored per-provider LLM config (`llm.providerConfigs`), folded with any legacy flat values for the
   *  active provider. The UI seeds provider-scoped fields from this, keyed by the selected provider, so
   *  switching providers instantly shows that provider's own values. */
  providerConfigs?: Record<string, Record<string, unknown>>;
}

/** The API key field for the BYO-key providers. The user enters the key itself (treated as a password
 *  and stored in the OS keychain via the secret endpoints); `llm.apiKeyEnv` — which env var the key is
 *  read from — stays an advanced CLI/config-file setting, not exposed here. The secret name per provider
 *  is its standard key env var, from the registry. */
const API_KEY_FIELD: SecretFieldDescriptor = {
  key: "llm.apiKey",
  label: "API key",
  description: "Stored securely on this machine (OS keychain).",
  activeWhen: { path: "taskExtraction.enabled" },
  providerPath: "llm.provider",
  secretNames: Object.fromEntries(
    providersForConfigField("apiKeyEnv").map((p) => [p, getProvider(p)!.apiKeyEnv!]),
  ),
};

/** The Argus Hub key, stored in the OS keychain (under `ARGUS_HUB_KEY`) via the secret endpoints —
 *  never in `argus.json`. A fixed secret (no provider dimension); rendered beneath the Hub URL. A
 *  legacy plaintext `hub.key` in argus.json is migrated into the keychain on serve start (secrets.ts). */
const HUB_KEY_FIELD: SecretFieldDescriptor = {
  key: "hub.key",
  label: "Hub key",
  description: "Stored securely on this machine (OS keychain).",
  providerPath: "hub.url",
  secretName: HUB_SETTINGS.key.env!,
};

type LayoutSection = {
  label?: string;
  settings: Setting<unknown>[];
  secrets?: SecretFieldDescriptor[];
  connectionTest?: ConnectionTestDescriptor;
};

/** The category → section → setting layout for the surface. Categories and their order are the
 *  product's grouping of the `argus.json` surface; the settings themselves are the registry descriptors,
 *  so types/defaults/validation come from one place.
 *
 *  Only the settings listed here are editable in the UI. Some are deliberately CLI/config-file only
 *  (advanced) and must NOT be added — notably `retainText` (#120), which stays an `argus config` /
 *  `ARGUS_RETAIN_TEXT` / `--retain-text` setting. */
const LAYOUT: { id: string; label: string; sections: LayoutSection[] }[] = [
  {
    // General. Appearance (the color theme) is a client-only preference the surface renders itself — not
    // an `argus.json` setting, so no registry descriptor here. The Argus Hub connection lives here too
    // (it used to be its own tab): the URL is a plain setting; the key is secret-store-backed
    // (HUB_KEY_FIELD), like the LLM API keys.
    id: "general",
    label: "General",
    sections: [
      { label: "Updates", settings: [AUTO_UPDATE_SETTINGS.enabled] },
      { label: "Argus Hub", settings: [HUB_SETTINGS.url], secrets: [HUB_KEY_FIELD] },
      // Terminal verbosity for this `argus serve` process. A change here applies to the running
      // logger immediately (see the PUT /api/settings handler), not just the next start.
      { label: "Logging", settings: [LOG_SETTINGS.level] },
    ],
  },
  {
    // Sessions = task extraction + the LLM that powers it (its only consumer today). One group: the
    // Extract-tasks toggle, the hourly cap, then the LLM provider + its provider-specific fields, the
    // API key, and the Test-connection action. (Custom prompt / prompt file aren't exposed yet; advanced
    // / CLI-only and not shown here: `llm.apiKeyEnv` — the UI offers the key itself via API_KEY_FIELD —
    // `llm.baseUrl`, and `llm.maxTokens`. `claudeCliPath` shows only for claude-cli, per its configFields.)
    id: "sessions",
    label: "Sessions",
    sections: [
      {
        settings: [
          TASK_SETTINGS.enabled,
          TASK_SETTINGS.maxSessionsPerHour,
          LLM_SETTINGS.provider,
          LLM_SETTINGS.model,
          LLM_SETTINGS.claudeCliPath,
          LLM_SETTINGS.command,
        ],
        secrets: [API_KEY_FIELD],
        connectionTest: { activeWhen: { path: "taskExtraction.enabled" } },
      },
    ],
  },
];

/** Every setting the surface can edit, keyed by dotted path — the write allowlist. Only settings that
 *  appear in a category section (and therefore carry UI metadata) are editable through the API. */
const EDITABLE: Map<string, Setting<unknown>> = new Map(
  LAYOUT.flatMap((cat) => cat.sections).flatMap((sec) => sec.settings).map((s) => [s.path, s]),
);

/** Editable provider-scoped settings keyed by bare field name (`model`, `command`, `claudeCliPath`) —
 *  the allowlist for `llm.providerConfigs.<provider>.<field>` writes. */
const EDITABLE_PROVIDER_FIELDS: Map<string, Setting<unknown>> = new Map(
  [...EDITABLE.values()].filter((s) => s.providerScoped).map((s) => [llmFieldName(s), s]),
);

/** Match a provider-scoped write path: `llm.providerConfigs.<provider>.<field>`. */
const PROVIDER_CONFIG_PATH = /^llm\.providerConfigs\.([^.]+)\.([^.]+)$/;

/** Build the JSON-safe descriptor for one setting. A provider-scoped field carries only its identity
 *  (`field`) — its per-provider values travel in the response's `providerConfigs` map (keyed by the
 *  selected provider), so the descriptor doesn't pin a single (active-provider-only) value. `claudeBinary`
 *  (the auto-resolved `claude` path) is threaded in only by the serve route, so the resolution (which may
 *  spawn a login shell) is an explicit caller concern, not a side effect of describing. */
function describe(setting: Setting<unknown>, file: ArgusConfig, opts: { claudeBinary?: string } = {}): SettingDescriptor {
  const scoped = setting.providerScoped === true;
  // Resolve with no flags — the serve process carries none, so only an env var can override the file.
  const descriptor: SettingDescriptor = {
    path: setting.path,
    ui: setting.ui!,
    secret: setting.secret === true,
    fileValue: scoped ? null : (getPath(file, setting.path) ?? null),
    effectiveValue: scoped ? null : (resolveSetting(setting, {}, file) ?? null),
  };
  if (scoped) {
    descriptor.providerScoped = true;
    descriptor.field = llmFieldName(setting);
  }
  if (setting.env && present(process.env[setting.env])) {
    descriptor.override = { layer: "env", name: setting.env };
  }
  // A setting can declare a server-computed placeholder source (ui.placeholderFrom). Today the only one
  // is the auto-resolved `claude` binary, so the user sees what "leave blank to auto-detect" would use.
  if (setting.ui?.placeholderFrom === "claudeBinary" && opts.claudeBinary) descriptor.placeholder = opts.claudeBinary;
  return descriptor;
}

/** The stored per-provider LLM config, folded with any legacy flat values for the active provider, so
 *  the UI can seed provider-scoped fields per provider (and a pre-`providerConfigs` flat value still
 *  shows under the provider it applies to). */
function buildProviderConfigs(file: ArgusConfig): Record<string, Record<string, unknown>> {
  const stored = (file.llm?.providerConfigs ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [prov, cfg] of Object.entries(stored)) out[prov] = { ...cfg };
  // Fold legacy flat fields into the active provider (scoped values win), so an old `llm.model` etc.
  // still pre-populates its field instead of looking unset.
  const prov = resolveActiveProvider(file);
  const legacy: Record<string, unknown> = {};
  for (const s of EDITABLE.values()) {
    if (!s.providerScoped) continue;
    const v = getPath(file, s.path);
    if (present(v)) legacy[llmFieldName(s)] = v;
  }
  if (Object.keys(legacy).length) out[prov] = { ...legacy, ...(out[prov] ?? {}) };
  return out;
}

/** Build the full settings surface payload from `argus.json` (defaults to the live file). `claudeBinary`
 *  is the auto-resolved `claude` path used as the Claude CLI path placeholder; the serve route passes
 *  it (via `resolveClaudeBinary()`) and other callers can omit it. */
export function describeSettings(file: ArgusConfig = loadConfig(), claudeBinary?: string): SettingsResponse {
  return {
    categories: LAYOUT.map((cat) => ({
      id: cat.id,
      label: cat.label,
      sections: cat.sections.map((sec) => ({
        label: sec.label,
        settings: sec.settings.filter((s) => s.ui).map((s) => describe(s, file, { claudeBinary })),
        ...(sec.secrets ? { secretFields: sec.secrets } : {}),
        ...(sec.connectionTest ? { connectionTest: sec.connectionTest } : {}),
      })),
    })),
    providerConfigs: buildProviderConfigs(file),
  };
}

export type ApplyResult =
  | { ok: true; setting: SettingDescriptor }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Validate and persist a single setting into `argus.json`, atomically. A null/empty `raw` clears the
 * setting (it falls back to env/default). Anything the setting's `parse()` rejects (an unknown enum
 * value, a non-numeric number) comes back as a 400 with a clear message — never written. Returns the
 * refreshed descriptor so the caller can reflect the saved + effective value.
 */
export function applySetting(path: string, raw: unknown, configPath: string = CONFIG_FILE): ApplyResult {
  // A path is either a flat editable setting, or a provider-scoped write
  // (`llm.providerConfigs.<provider>.<field>`) — resolve which.
  let setting: Setting<unknown> | undefined;
  const scoped = PROVIDER_CONFIG_PATH.exec(path);
  if (scoped) {
    const [, prov, field] = scoped;
    // Gate the write on the *target* provider's own registry descriptor — not just "is a known
    // provider" — so we can't persist a field the provider never reads (e.g. claudeCliPath/command on
    // openai), which would be silent junk in argus.json the UI never surfaces. This rejects reserved
    // providers (no configFields offered) and "off" (no configFields) too, matching what the UI offers.
    const provider = getProvider(prov!);
    if (!provider || provider.reserved || !provider.configFields?.some((f) => f === field)) {
      return { ok: false, status: 404, error: `Provider "${prov}" has no "${field}" setting.` };
    }
    setting = EDITABLE_PROVIDER_FIELDS.get(field!);
  } else {
    setting = EDITABLE.get(path);
  }
  if (!setting) return { ok: false, status: 404, error: `Unknown or non-editable setting "${path}".` };

  const file = loadConfig(configPath) as ArgusConfig & Record<string, unknown>;
  const clearing = raw == null || raw === "";

  let value: unknown;
  if (!clearing) {
    value = setting.parse(raw);
    // parse() returns undefined to reject a present-but-invalid value (e.g. bad enum / NaN). A coerced
    // value is never undefined, so undefined here means "rejected".
    if (value === undefined) {
      const values = (setting.ui?.options ?? [])
        .filter((o): o is SelectOption => o !== "separator" && o.value !== "")
        .map((o) => o.value);
      const hint = values.length
        ? ` (expected one of: ${values.join(", ")})`
        : setting.ui?.min != null
          ? ` (must be ${setting.ui.min} or more)`
          : "";
      return { ok: false, status: 400, error: `Invalid value for ${setting.ui?.label ?? path}${hint}.` };
    }
  }

  // Clearing writes `undefined`, which JSON.stringify omits — so the key is dropped from the file and
  // the setting falls back through the resolver chain on next load.
  setPath(file as Record<string, unknown>, path, value);
  writeConfigAtomic(file, configPath);
  return { ok: true, setting: describe(setting, file) };
}

export interface ConnectionTestResult {
  ok: boolean;
  /** The provider that was tested (e.g. "openai"). */
  provider: string;
  /** The model the test ran against, when known. */
  model?: string;
  /** A diagnostic when the test failed (a missing key, an auth/network error, no completion). */
  error?: string;
}

function sanitizedUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "<configured>";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<configured>";
  }
}

/** A one-line, secret-free description of what the connection test will run, for the debug log.
 *  User-controlled command contents, URL credentials, query strings, fragments, and local paths are
 *  intentionally redacted. */
function describeLlmInvocation(llm: ResolvedLlmConfig): string {
  switch (llm.provider) {
    case "claude-cli":
      return [
        "provider=claude-cli",
        `binary=${llm.claudeCliPath?.trim() ? "<configured>" : "<auto>"}`,
        `args=${claudeProviderArgs(llm.model).join(" ")}`,
      ].join(" ");
    case "command":
      return llm.command?.trim()
        ? "provider=command command=<configured>"
        : "provider=command command=<unset>";
    default: {
      const parts = [`provider=${llm.provider}`];
      if (llm.model) parts.push(`model=${llm.model}`);
      if (llm.baseUrl) parts.push(`baseUrl=${sanitizedUrlForLog(llm.baseUrl)}`);
      return parts.join(" ");
    }
  }
}

/**
 * Run a tiny live completion through the currently-configured provider so the user can confirm their
 * setup (provider + key + model) actually works. Resolves the LLM config from `argus.json` plus the
 * API key from the secret store, sends a one-word prompt, and reports whether a completion came back.
 * Never throws — the LLM client turns missing keys / auth / network errors into `ok:false`.
 *
 * Logs (when a sink is given): INFO when the test starts and again with the outcome on success, a
 * DEBUG line with the full invocation (secret-free), and WARN with the diagnostic on failure.
 */
export async function testLlmConnection(opts: {
  configPath?: string;
  secrets: SecretStore;
  fetch?: typeof fetch;
  log?: Log;
}): Promise<ConnectionTestResult> {
  const file = loadConfig(opts.configPath ?? CONFIG_FILE);
  const { llm } = resolveTaskExtraction({}, file);
  const apiKey = await resolveApiKey(llm.apiKeyEnv, opts.secrets);

  const log = opts.log;
  const label = `${llm.provider}${llm.model ? ` (model ${llm.model})` : ""}`;
  if (log) {
    logAt(log, "info", `Testing the ${label} connection...`);
    logDebug(log, `Connection test invocation: ${describeLlmInvocation(llm)}`);
  }

  const result = await complete(
    {
      system: "You are a connectivity check. Reply with the single word: OK.",
      prompt: "ping",
      maxTokens: 16,
    },
    { ...llm, apiKey },
    { fetch: opts.fetch },
  );

  if (log) {
    if (result.ok) logAt(log, "info", `Connection test succeeded for ${label}.`);
    else logAt(log, "warn", `Connection test failed for ${label}: ${result.error ?? "no completion returned"}`);
  }

  return {
    ok: result.ok,
    provider: llm.provider,
    model: llm.model,
    error: result.ok ? undefined : result.error,
  };
}
