import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALL_SETTINGS,
  getPath,
  loadConfig,
  migrateLlmFlatToProviderConfigs,
  migrateTaskExtractionToSessionInterpretation,
  resolveAutoUpdateCheckIntervalMinutes,
  resolveAutoUpdateEnabled,
  resolveDesktopStartAtLogin,
  resolveLogLevel,
  resolveRetainText,
  resolveSetting,
  resolveSessionInterpretation,
  type Setting,
} from "../src/config.ts";
import { logger } from "../src/logger.ts";

function tmpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-config-"));
  const path = join(dir, "argus.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

const CONFIG_ENV = [
  "ARGUS_AUTO_UPDATE_CHECK_INTERVAL_MINUTES",
  "ARGUS_AUTO_UPDATE_ENABLED",
  "ARGUS_DESKTOP_START_AT_LOGIN",
  "ARGUS_TASK_ENABLED",
  "ARGUS_TASK_PROVIDER",
  "ARGUS_TASK_MODEL",
  "ARGUS_TASK_PROMPT",
  "ARGUS_TASK_PROMPT_FILE",
  "ARGUS_TASK_COMMAND",
  "ARGUS_RETAIN_TEXT",
  "ARGUS_LOG_LEVEL",
];

afterEach(() => {
  for (const key of CONFIG_ENV) delete process.env[key];
});

describe("loadConfig", () => {
  test("missing file → defaults, no warning", () => {
    const warnings: string[] = [];
    const cfg = loadConfig(join(tmpdir(), "does-not-exist-argus.json"), (m) => warnings.push(m));
    expect(cfg).toEqual({});
    expect(warnings).toHaveLength(0);
  });

  test("valid file → parsed object", () => {
    const path = tmpConfig(JSON.stringify({ taskExtraction: { enabled: true, provider: "claude-cli" } }));
    expect(loadConfig(path)).toEqual({ taskExtraction: { enabled: true, provider: "claude-cli" } });
  });

  test("malformed JSON → warning + defaults, no throw", () => {
    const warnings: string[] = [];
    const path = tmpConfig("{ not valid json");
    const cfg = loadConfig(path, (m) => warnings.push(m));
    expect(cfg).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Using defaults");
  });

  test("non-object JSON (array) → warning + defaults", () => {
    const warnings: string[] = [];
    const path = tmpConfig("[1, 2, 3]");
    expect(loadConfig(path, (m) => warnings.push(m))).toEqual({});
    expect(warnings).toHaveLength(1);
  });
});

describe("getPath", () => {
  test("dotted camelCase lookup; undefined on any missing segment", () => {
    const obj = { taskExtraction: { provider: "claude" } };
    expect(getPath(obj, "taskExtraction.provider")).toBe("claude");
    expect(getPath(obj, "taskExtraction.missing")).toBeUndefined();
    expect(getPath(obj, "nope.deep.path")).toBeUndefined();
  });
});

describe("resolveSetting precedence", () => {
  const setting: Setting<string> = {
    path: "taskExtraction.provider",
    env: "ARGUS_TASK_PROVIDER",
    flag: "task-provider",
    default: "claude",
    parse: (raw) => String(raw),
  };

  test("flag wins over env, file, default", () => {
    process.env.ARGUS_TASK_PROVIDER = "command";
    const file = { taskExtraction: { provider: "off" as const } };
    expect(resolveSetting(setting, { "task-provider": "claude" }, file)).toBe("claude");
  });

  test("env wins over file and default when flag absent", () => {
    process.env.ARGUS_TASK_PROVIDER = "command";
    const file = { taskExtraction: { provider: "off" as const } };
    expect(resolveSetting(setting, {}, file)).toBe("command");
  });

  test("file wins over default when flag and env absent", () => {
    const file = { taskExtraction: { provider: "off" as const } };
    expect(resolveSetting(setting, {}, file)).toBe("off");
  });

  test("default when every layer is absent", () => {
    expect(resolveSetting(setting, {}, {})).toBe("claude");
  });
});

describe("resolveSessionInterpretation", () => {
  test("acceptance #89: file enables extraction with no flags", () => {
    const file = { taskExtraction: { enabled: true, provider: "claude-cli" as const } };
    const resolved = resolveSessionInterpretation({}, file);
    expect(resolved.enabled).toBe(true);
    expect(resolved.llm.provider).toBe("claude-cli");
  });

  test("empty config → today's defaults (enabled, provider claude-cli, no extras)", () => {
    const resolved = resolveSessionInterpretation({}, {});
    expect(resolved.enabled).toBe(true);
    expect(resolved.llm.provider).toBe("claude-cli");
    expect(resolved.llm.model).toBeUndefined();
    expect(resolved.llm.command).toBeUndefined();
  });

  test("taskExtraction.enabled: false in config stays false", () => {
    expect(resolveSessionInterpretation({}, { taskExtraction: { enabled: false } }).enabled).toBe(false);
  });

  test("taskExtraction.enabled: true in config stays true", () => {
    expect(resolveSessionInterpretation({}, { taskExtraction: { enabled: true } }).enabled).toBe(true);
  });

  test("no taskExtraction.enabled in config defaults to true", () => {
    expect(resolveSessionInterpretation({}, {}).enabled).toBe(true);
    expect(resolveSessionInterpretation({}, { taskExtraction: {} }).enabled).toBe(true);
  });

  test("resolves llm.claudeCliPath from the file (advanced override for the claude-cli binary)", () => {
    const resolved = resolveSessionInterpretation({}, { llm: { claudeCliPath: "/opt/claude/bin/claude" } });
    expect(resolved.llm.claudeCliPath).toBe("/opt/claude/bin/claude");
  });

  test("env var enables and overrides file provider", () => {
    process.env.ARGUS_TASK_ENABLED = "true";
    process.env.ARGUS_TASK_PROVIDER = "command";
    const file = { taskExtraction: { enabled: false, provider: "claude-cli" as const } };
    const resolved = resolveSessionInterpretation({}, file);
    expect(resolved.enabled).toBe(true);
    expect(resolved.llm.provider).toBe("command");
  });

  test("#93: --extract-tasks false forces off even when the file enables it", () => {
    const file = { taskExtraction: { enabled: true } };
    expect(resolveSessionInterpretation({ "extract-tasks": false }, file).enabled).toBe(false);
    expect(resolveSessionInterpretation({ "extract-tasks": true }, { taskExtraction: { enabled: false } }).enabled).toBe(true);
    // Unset (omitted) defers to the file.
    expect(resolveSessionInterpretation({}, file).enabled).toBe(true);
  });

  test("flag overrides env and file (deprecated --task-* aliases still resolve)", () => {
    process.env.ARGUS_TASK_PROVIDER = "command";
    const resolved = resolveSessionInterpretation(
      { "task-provider": "off", "task-model": "haiku" },
      { taskExtraction: { provider: "claude-cli" } },
    );
    expect(resolved.llm.provider).toBe("off");
    expect(resolved.llm.model).toBe("haiku");
  });

  test("#234: the canonical --interpret-* override flags resolve", () => {
    const resolved = resolveSessionInterpretation(
      { "interpret-provider": "off", "interpret-model": "haiku" },
      {},
    );
    expect(resolved.llm.provider).toBe("off");
    expect(resolved.llm.model).toBe("haiku");
  });

  test("boolean coercion of string env/file values", () => {
    expect(resolveSessionInterpretation({}, { taskExtraction: { enabled: true } }).enabled).toBe(true);
    process.env.ARGUS_TASK_ENABLED = "0";
    expect(resolveSessionInterpretation({}, {}).enabled).toBe(false);
  });

  test("an invalid provider warns and falls back instead of hard-exiting (#89 tolerant)", () => {
    const warnings: string[] = [];
    const original = logger.warn;
    logger.warn = (m?: unknown) => warnings.push(String(m));
    try {
      // A typo in argus.json must not kill an unrelated `index`/`serve`/`run`.
      const resolved = resolveSessionInterpretation({}, { taskExtraction: { provider: "cluade" as never } });
      expect(resolved.llm.provider).toBe("claude-cli");
      expect(warnings.join("\n")).toContain("Ignoring invalid LLM provider");
    } finally {
      logger.warn = original;
    }
  });

  test("legacy provider value 'claude' aliases to 'claude-cli' without warning", () => {
    const warnings: string[] = [];
    const original = logger.warn;
    logger.warn = (m?: unknown) => warnings.push(String(m));
    try {
      const resolved = resolveSessionInterpretation({}, { taskExtraction: { provider: "claude" as never } });
      expect(resolved.llm.provider).toBe("claude-cli");
      expect(warnings).toHaveLength(0);
    } finally {
      logger.warn = original;
    }
  });

  test("an exported-but-empty env var is treated as unset, not a value", () => {
    process.env.ARGUS_TASK_PROVIDER = "";
    // "" must fall through to the file rather than route through provider validation.
    expect(resolveSessionInterpretation({}, { taskExtraction: { provider: "command" } }).llm.provider).toBe("command");
  });

  test("reattaches log (not a persisted setting)", () => {
    const sink = () => {};
    expect(resolveSessionInterpretation({}, {}, sink).log).toBe(sink);
  });

  test("#234: title/summary char limits default to 100/500 and resolve from the file", () => {
    const d = resolveSessionInterpretation({}, {});
    expect(d.titleMaxChars).toBe(100);
    expect(d.summaryMaxChars).toBe(500);
    const overridden = resolveSessionInterpretation(
      {},
      { sessionInterpretation: { titleMaxChars: 60, summaryMaxChars: 300 } },
    );
    expect(overridden.titleMaxChars).toBe(60);
    expect(overridden.summaryMaxChars).toBe(300);
  });

  test("#234: effort is omitted when unset and passed through untranslated when set", () => {
    expect(resolveSessionInterpretation({}, {}).llm.effort).toBeUndefined();
    const withEffort = resolveSessionInterpretation(
      {},
      { llm: { provider: "claude-cli", providerConfigs: { "claude-cli": { effort: "high" } } } },
    );
    expect(withEffort.llm.effort).toBe("high");
  });
});

describe("migrateTaskExtractionToSessionInterpretation (#234)", () => {
  test("migrates a legacy taskExtraction block in place and resolves identically", () => {
    const path = tmpConfig(
      JSON.stringify({ taskExtraction: { enabled: false, maxSessionsPerHour: 12, provider: "command" } }),
    );
    expect(migrateTaskExtractionToSessionInterpretation(path)).toBe(true);
    const file = loadConfig(path);
    expect(file.taskExtraction).toBeUndefined();
    expect(file.sessionInterpretation).toEqual({ enabled: false, maxSessionsPerHour: 12, provider: "command" });
    // Resolution is unchanged by the migration.
    const resolved = resolveSessionInterpretation({}, file);
    expect(resolved.enabled).toBe(false);
    expect(resolved.maxSessionsPerHour).toBe(12);
    expect(resolved.llm.provider).toBe("command");
  });

  test("is a no-op with no legacy block, and new-key values win on conflict", () => {
    const empty = tmpConfig(JSON.stringify({ log: { level: "info" } }));
    expect(migrateTaskExtractionToSessionInterpretation(empty)).toBe(false);
    const both = tmpConfig(
      JSON.stringify({
        taskExtraction: { enabled: false, maxSessionsPerHour: 12 },
        sessionInterpretation: { enabled: true },
      }),
    );
    expect(migrateTaskExtractionToSessionInterpretation(both)).toBe(true);
    const file = loadConfig(both);
    expect(file.taskExtraction).toBeUndefined();
    // New-key `enabled: true` wins; the legacy-only `maxSessionsPerHour` is carried over.
    expect(file.sessionInterpretation).toEqual({ enabled: true, maxSessionsPerHour: 12 });
  });
});

describe("resolveLogLevel", () => {
  test("defaults to info", () => {
    expect(resolveLogLevel({}, {})).toBe("info");
  });

  test("argus.json and env can set the level", () => {
    expect(resolveLogLevel({}, { log: { level: "warn" } })).toBe("warn");
    process.env.ARGUS_LOG_LEVEL = "debug";
    expect(resolveLogLevel({}, { log: { level: "warn" } })).toBe("debug");
  });

  test("CLI shorthands win over env and file", () => {
    process.env.ARGUS_LOG_LEVEL = "error";
    expect(resolveLogLevel({ verbose: true }, { log: { level: "warn" } })).toBe("debug");
    expect(resolveLogLevel({ quiet: true }, { log: { level: "debug" } })).toBe("warn");
    expect(resolveLogLevel({ debug: true }, {})).toBe("debug");
  });

  test("--log-level wins over shorthand flags", () => {
    expect(resolveLogLevel({ "log-level": "trace", quiet: true }, {})).toBe("trace");
  });
});

describe("Setting secret flag", () => {
  test("desktop settings are known and not secret", () => {
    expect(ALL_SETTINGS["desktop.startAtLogin"]?.secret).toBeFalsy();
    expect(ALL_SETTINGS["desktop.silent"]?.secret).toBeFalsy();
  });

  test("auto-update settings are known and not secret", () => {
    expect(ALL_SETTINGS["autoUpdate.enabled"]?.secret).toBeFalsy();
    expect(ALL_SETTINGS["autoUpdate.checkIntervalMinutes"]?.secret).toBeFalsy();
  });

  test("hub.key is marked secret", () => {
    expect(ALL_SETTINGS["hub.key"]?.secret).toBe(true);
  });

  test("hub.url is not secret", () => {
    expect(ALL_SETTINGS["hub.url"]?.secret).toBeFalsy();
  });

  test("task settings are not secret", () => {
    for (const key of ["taskExtraction.enabled", "taskExtraction.provider", "taskExtraction.model"]) {
      expect(ALL_SETTINGS[key]?.secret).toBeFalsy();
    }
  });
});

// `desktop.silent` (#255) is an operator-level switch: `argus config get/set` must know it, but the
// Settings screen must never show it (no `ui` metadata — the layout in src/api/settings.ts only
// surfaces settings it lists explicitly).
describe("desktop.silent", () => {
  test("is registered for `argus config get/set` with a false default", () => {
    const setting = ALL_SETTINGS["desktop.silent"]!;
    expect(setting).toBeDefined();
    expect(setting.default).toBe(false);
    expect(setting.env).toBe("ARGUS_DESKTOP_SILENT");
    expect(setting.parse("true")).toBe(true);
    expect(setting.parse("off")).toBe(false);
  });

  test("carries no UI metadata, keeping it out of the Settings screen", () => {
    expect(ALL_SETTINGS["desktop.silent"]!.ui).toBeUndefined();
  });
});

// `resolveDesktopStartAtLogin` is currently latent restore-plumbing: start-at-login is
// hard-disabled in the desktop shell (see `desktop_start_at_login_enabled` in lib.rs), which ignores
// this resolver entirely, and the Settings toggle is removed from the UI. These tests keep the
// resolver mechanics honest for when the feature is re-enabled.
describe("resolveDesktopStartAtLogin", () => {
  test("defaults to disabled", () => {
    expect(resolveDesktopStartAtLogin({}, {})).toBe(false);
  });

  test("resolver returns true when argus.json sets it (shell ignores it while disabled)", () => {
    expect(resolveDesktopStartAtLogin({}, { desktop: { startAtLogin: true } })).toBe(true);
  });

  test("env var overrides argus.json", () => {
    process.env.ARGUS_DESKTOP_START_AT_LOGIN = "no";
    expect(resolveDesktopStartAtLogin({}, { desktop: { startAtLogin: true } })).toBe(false);
  });
});

describe("resolveAutoUpdateEnabled", () => {
  test("defaults to enabled", () => {
    expect(resolveAutoUpdateEnabled({}, {})).toBe(true);
  });

  test("argus.json can disable automatic updates", () => {
    expect(resolveAutoUpdateEnabled({}, { autoUpdate: { enabled: false } })).toBe(false);
  });

  test("env var overrides argus.json", () => {
    process.env.ARGUS_AUTO_UPDATE_ENABLED = "yes";
    expect(resolveAutoUpdateEnabled({}, { autoUpdate: { enabled: false } })).toBe(true);
  });
});

describe("resolveAutoUpdateCheckIntervalMinutes", () => {
  test("defaults to 60 minutes", () => {
    expect(resolveAutoUpdateCheckIntervalMinutes({}, {})).toBe(60);
  });

  test("argus.json can set the update check interval", () => {
    expect(
      resolveAutoUpdateCheckIntervalMinutes({}, { autoUpdate: { checkIntervalMinutes: 15 } }),
    ).toBe(15);
  });

  test("env var overrides argus.json", () => {
    process.env.ARGUS_AUTO_UPDATE_CHECK_INTERVAL_MINUTES = "30";
    expect(
      resolveAutoUpdateCheckIntervalMinutes({}, { autoUpdate: { checkIntervalMinutes: 15 } }),
    ).toBe(30);
  });

  test("invalid values fall back to the default", () => {
    expect(
      resolveAutoUpdateCheckIntervalMinutes({}, { autoUpdate: { checkIntervalMinutes: 0 } }),
    ).toBe(60);
  });
});

describe("resolveRetainText", () => {
  test("defaults to on (core capability, opt-out)", () => {
    expect(resolveRetainText({}, {})).toBe(true);
  });

  test("argus.json can opt out", () => {
    expect(resolveRetainText({}, { retainText: false })).toBe(false);
  });

  test("env var overrides argus.json", () => {
    process.env.ARGUS_RETAIN_TEXT = "false";
    expect(resolveRetainText({}, { retainText: true })).toBe(false);
  });

  test("flag overrides env and file", () => {
    process.env.ARGUS_RETAIN_TEXT = "false";
    expect(resolveRetainText({ "retain-text": true }, { retainText: false })).toBe(true);
  });

  test("empty env value falls through to the default", () => {
    process.env.ARGUS_RETAIN_TEXT = "";
    expect(resolveRetainText({}, {})).toBe(true);
  });
});

describe("llm block (#132)", () => {
  afterEach(() => {
    for (const k of ["ARGUS_LLM_PROVIDER", "ARGUS_LLM_MODEL", "ARGUS_LLM_MAX_TOKENS", "ARGUS_LLM_BASE_URL", "ARGUS_LLM_API_KEY_ENV"]) {
      delete process.env[k];
    }
  });

  test("task extraction reads the shared llm.* block", () => {
    const file = {
      taskExtraction: { enabled: true },
      llm: { provider: "claude-api" as const, model: "claude-haiku-4-5", maxTokens: 4096, baseUrl: "http://x" },
    };
    const resolved = resolveSessionInterpretation({}, file);
    expect(resolved.llm).toMatchObject({
      provider: "claude-api",
      model: "claude-haiku-4-5",
      maxTokens: 4096,
      baseUrl: "http://x",
      apiKeyEnv: "ANTHROPIC_API_KEY", // defaulted from the provider
    });
  });

  test("provider-scoped: each provider keeps its own model under providerConfigs", () => {
    const providerConfigs = {
      openai: { model: "gpt-5.4-mini" },
      "claude-api": { model: "claude-sonnet-4-6" },
    };
    expect(resolveSessionInterpretation({}, { llm: { provider: "openai", providerConfigs } }).llm.model).toBe("gpt-5.4-mini");
    expect(resolveSessionInterpretation({}, { llm: { provider: "claude-api", providerConfigs } }).llm.model).toBe(
      "claude-sonnet-4-6",
    );
  });

  test("provider-scoped: a provider's own config wins over the legacy flat value", () => {
    const file = { llm: { provider: "openai" as const, model: "flat-legacy", providerConfigs: { openai: { model: "scoped" } } } };
    expect(resolveSessionInterpretation({}, file).llm.model).toBe("scoped");
  });

  test("provider-scoped: legacy flat llm.model still resolves as a fallback", () => {
    expect(resolveSessionInterpretation({}, { llm: { provider: "openai", model: "flat-legacy" } }).llm.model).toBe("flat-legacy");
  });

  test("provider-scoped: env (ARGUS_LLM_MODEL) overrides the active provider's stored model", () => {
    process.env.ARGUS_LLM_MODEL = "env-model";
    const file = { llm: { provider: "openai" as const, providerConfigs: { openai: { model: "scoped" } } } };
    expect(resolveSessionInterpretation({}, file).llm.model).toBe("env-model");
  });

  test("apiKeyEnv defaults per provider but an explicit value wins", () => {
    expect(resolveSessionInterpretation({}, { llm: { provider: "openai" } }).llm.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(resolveSessionInterpretation({}, { llm: { provider: "gemini" } }).llm.apiKeyEnv).toBe("GEMINI_API_KEY");
    expect(
      resolveSessionInterpretation({}, { llm: { provider: "openai", apiKeyEnv: "MY_KEY" } }).llm.apiKeyEnv,
    ).toBe("MY_KEY");
  });

  test("the deprecated taskExtraction.provider overrides the shared llm.provider", () => {
    const file = { llm: { provider: "claude-api" as const }, taskExtraction: { provider: "claude-cli" as const } };
    expect(resolveSessionInterpretation({}, file).llm.provider).toBe("claude-cli");
  });

  test("local providers carry no apiKeyEnv", () => {
    expect(resolveSessionInterpretation({}, { llm: { provider: "claude-cli" } }).llm.apiKeyEnv).toBeUndefined();
  });

  test("openrouter is a first-class provider with its own key env", () => {
    const resolved = resolveSessionInterpretation({}, { llm: { provider: "openrouter" } });
    expect(resolved.llm.provider).toBe("openrouter");
    expect(resolved.llm.apiKeyEnv).toBe("OPENROUTER_API_KEY");
  });
});

describe("migrateLlmFlatToProviderConfigs (#154 review)", () => {
  test("folds legacy flat llm.* under the file's configured provider and drops the flat keys", () => {
    const path = tmpConfig(JSON.stringify({ llm: { provider: "openai", model: "gpt-5", apiKeyEnv: "MY_OPENAI_KEY" } }));
    expect(migrateLlmFlatToProviderConfigs(path)).toBe(true);
    const cfg = loadConfig(path);
    expect(cfg.llm?.model).toBeUndefined(); // flat keys removed
    expect(cfg.llm?.apiKeyEnv).toBeUndefined();
    expect(cfg.llm?.providerConfigs?.openai).toEqual({ model: "gpt-5", apiKeyEnv: "MY_OPENAI_KEY" });
    expect(cfg.llm?.provider).toBe("openai"); // the active provider selector is left in place
  });

  test("stops the cross-provider bleed: after migrating, switching providers picks up the new provider's default key env", () => {
    // Pre-migration, the flat apiKeyEnv leaks into whatever provider is active.
    const path = tmpConfig(JSON.stringify({ llm: { provider: "claude-api", apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-x" } }));
    migrateLlmFlatToProviderConfigs(path);
    const file = loadConfig(path);
    // The original provider keeps its values…
    expect(resolveSessionInterpretation({}, file).llm).toMatchObject({ provider: "claude-api", apiKeyEnv: "ANTHROPIC_API_KEY", model: "claude-x" });
    // …but gemini now resolves its own default, not the stale flat ANTHROPIC_API_KEY.
    expect(resolveSessionInterpretation({}, { ...file, llm: { ...file.llm!, provider: "gemini" } }).llm.apiKeyEnv).toBe("GEMINI_API_KEY");
  });

  test("targets the file's persisted provider, not an env override", () => {
    const path = tmpConfig(JSON.stringify({ llm: { provider: "claude-api", model: "claude-x" } }));
    process.env.ARGUS_LLM_PROVIDER = "gemini"; // a runtime override must not capture the flat values
    try {
      migrateLlmFlatToProviderConfigs(path);
      const cfg = loadConfig(path);
      expect(cfg.llm?.providerConfigs?.["claude-api"]).toEqual({ model: "claude-x" });
      expect(cfg.llm?.providerConfigs?.gemini).toBeUndefined();
    } finally {
      delete process.env.ARGUS_LLM_PROVIDER;
    }
  });

  test("an already-scoped value wins over the flat one", () => {
    const path = tmpConfig(JSON.stringify({ llm: { provider: "openai", model: "flat", providerConfigs: { openai: { model: "scoped" } } } }));
    migrateLlmFlatToProviderConfigs(path);
    expect(loadConfig(path).llm?.providerConfigs?.openai?.model).toBe("scoped");
  });

  test("no flat values: a no-op that doesn't rewrite the file", () => {
    const path = tmpConfig(JSON.stringify({ llm: { provider: "openai", providerConfigs: { openai: { model: "gpt-5" } } } }));
    expect(migrateLlmFlatToProviderConfigs(path)).toBe(false);
  });

  test("unset provider folds flat values under the default provider", () => {
    const path = tmpConfig(JSON.stringify({ llm: { model: "haiku" } }));
    expect(migrateLlmFlatToProviderConfigs(path)).toBe(true);
    expect(loadConfig(path).llm?.providerConfigs?.["claude-cli"]).toEqual({ model: "haiku" });
  });
});
