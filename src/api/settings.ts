// The settings surface behind GET/PUT /api/settings (#154): a registry-driven view of everything
// settable in `argus.json`, plus a validated, atomic single-setting write. Everything here derives
// from the settings registry in `config.ts` (each setting binds its names, `parse()`, default, and
// UI metadata), so the web surface stays in sync with the config surface rather than hand-listing
// fields. This module only *groups* and *serializes* — the value contract stays in `config.ts`.
import {
  getPath,
  loadConfig,
  LLM_SETTINGS,
  present,
  resolveSetting,
  setPath,
  TASK_SETTINGS,
  writeConfigAtomic,
  type ArgusConfig,
  type SelectOption,
  type Setting,
  type SettingUi,
} from "../config.ts";
import { getProvider, providersForConfigField } from "../llm/index.ts";
import { CONFIG_FILE } from "../paths.ts";

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
}

/** An API-key field in the surface, backed by the secret store (#132), not `argus.json`. The actual
 *  key is written/read through the `/api/settings/secrets/:name` endpoints (masked status only, never
 *  the raw value), so it's treated like a password. The target secret name depends on the selected
 *  provider, so the field carries the provider → secret-name map and is shown only for those providers. */
export interface SecretFieldDescriptor {
  /** Stable id for the UI (not a stored argus.json path). */
  key: string;
  label: string;
  description?: string;
  /** Gate: inactive unless the boolean setting at this path is on (task extraction). */
  activeWhen?: { path: string };
  /** The field whose selected value picks which secret to read/write (the provider select). */
  providerPath: string;
  /** provider value → the secret name (env var) the key is stored under. The field is shown only for
   *  the providers present here (those that take an API key). */
  secretNames: Record<string, string>;
}

/** A labeled group of settings within a category (the right-pane sub-sections). */
export interface SettingsSection {
  label?: string;
  settings: SettingDescriptor[];
  /** Secret-store-backed fields (e.g. the API key), rendered after the plain settings. */
  secretFields?: SecretFieldDescriptor[];
}

/** A left-nav category and its sectioned settings. */
export interface SettingsCategory {
  id: string;
  label: string;
  sections: SettingsSection[];
}

export interface SettingsResponse {
  categories: SettingsCategory[];
}

/** The category → section → setting layout for the surface. Categories and their order are the
 *  product's grouping of the `argus.json` surface; the settings themselves are the registry
 *  descriptors, so types/defaults/validation come from one place. General is intentionally empty
 *  for now (#154).
 *
 *  Only the settings listed here are editable in the UI. Some settings are deliberately CLI/config-file
 *  only (advanced) and must NOT be added here — notably `retainText` (#120), which stays an
 *  `argus config` / `ARGUS_RETAIN_TEXT` / `--retain-text` setting. */
/** The API key field for the BYO-key providers. The user enters the key itself (treated as a password
 *  and stored in the OS keychain via the secret endpoints); `llm.apiKeyEnv` — which env var the key is
 *  read from — stays an advanced CLI/config-file setting, not exposed here. The secret name per provider
 *  is its standard key env var, from the registry. */
const API_KEY_FIELD: SecretFieldDescriptor = {
  key: "llm.apiKey",
  label: "API key",
  description: "Stored securely on this machine (OS keychain) and never uploaded.",
  activeWhen: { path: "taskExtraction.enabled" },
  providerPath: "llm.provider",
  secretNames: Object.fromEntries(
    providersForConfigField("apiKeyEnv").map((p) => [p, getProvider(p)!.apiKeyEnv!]),
  ),
};

type LayoutSection = { label?: string; settings: Setting<unknown>[]; secrets?: SecretFieldDescriptor[] };

const LAYOUT: { id: string; label: string; sections: LayoutSection[] }[] = [
  { id: "general", label: "General", sections: [] },
  {
    // Task extraction + the LLM that powers it live together: task extraction is the only consumer of
    // the LLM settings today, so they're one tab. Two (unlabeled) sections keep the task on/off + prompt
    // grouped apart from the model config; sub-section labels can be added back if this grows.
    id: "interpretation",
    label: "Session Interpretation",
    sections: [
      // Custom prompt / prompt file are intentionally not exposed yet.
      { settings: [TASK_SETTINGS.enabled] },
      {
        // `llm.apiKeyEnv` (which env var the key is read from) is advanced/CLI-only; the UI offers the
        // key itself (API_KEY_FIELD) instead.
        settings: [
          LLM_SETTINGS.provider,
          LLM_SETTINGS.model,
          LLM_SETTINGS.baseUrl,
          LLM_SETTINGS.maxTokens,
          LLM_SETTINGS.command,
        ],
        secrets: [API_KEY_FIELD],
      },
    ],
  },
];

/** Every setting the surface can edit, keyed by dotted path — the write allowlist. Only settings that
 *  appear in a category section (and therefore carry UI metadata) are editable through the API. */
const EDITABLE: Map<string, Setting<unknown>> = new Map(
  LAYOUT.flatMap((cat) => cat.sections).flatMap((sec) => sec.settings).map((s) => [s.path, s]),
);

/** Build the JSON-safe descriptor for one setting against the given config file contents. */
function describe(setting: Setting<unknown>, file: ArgusConfig): SettingDescriptor {
  const fileValue = getPath(file, setting.path) ?? null;
  // Resolve with no flags: the serve process doesn't carry the CLI flags, so the only layer that can
  // override the file here is an env var. resolveSetting still applies the file value and default.
  const effectiveValue = resolveSetting(setting, {}, file) ?? null;
  const descriptor: SettingDescriptor = {
    path: setting.path,
    ui: setting.ui!,
    secret: setting.secret === true,
    fileValue,
    effectiveValue,
  };
  if (setting.env && present(process.env[setting.env])) {
    descriptor.override = { layer: "env", name: setting.env };
  }
  return descriptor;
}

/** Build the full settings surface payload from `argus.json` (defaults to the live file). */
export function describeSettings(file: ArgusConfig = loadConfig()): SettingsResponse {
  return {
    categories: LAYOUT.map((cat) => ({
      id: cat.id,
      label: cat.label,
      sections: cat.sections.map((sec) => ({
        label: sec.label,
        settings: sec.settings.filter((s) => s.ui).map((s) => describe(s, file)),
        ...(sec.secrets ? { secretFields: sec.secrets } : {}),
      })),
    })),
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
  const setting = EDITABLE.get(path);
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
      const allowed = values.length ? ` (expected one of: ${values.join(", ")})` : "";
      return { ok: false, status: 400, error: `Invalid value for ${setting.ui?.label ?? path}${allowed}.` };
    }
  }

  // Clearing writes `undefined`, which JSON.stringify omits — so the key is dropped from the file and
  // the setting falls back through the resolver chain on next load.
  setPath(file as Record<string, unknown>, path, value);
  writeConfigAtomic(file, configPath);
  return { ok: true, setting: describe(setting, file) };
}
