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

/** A labeled group of settings within a category (the right-pane sub-sections). */
export interface SettingsSection {
  label?: string;
  settings: SettingDescriptor[];
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
 *  for now (#154). */
const LAYOUT: { id: string; label: string; sections: { label?: string; settings: Setting<unknown>[] }[] }[] = [
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
        settings: [
          LLM_SETTINGS.provider,
          LLM_SETTINGS.model,
          LLM_SETTINGS.baseUrl,
          LLM_SETTINGS.apiKeyEnv,
          LLM_SETTINGS.maxTokens,
          LLM_SETTINGS.command,
        ],
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
