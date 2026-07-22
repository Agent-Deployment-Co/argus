import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetting, describeSettings, testLlmConnection } from "../src/api/settings.ts";
import { loadConfig } from "../src/config.ts";
import { FileSecretStore } from "../src/secrets.ts";
import type { Log } from "../src/logger.ts";

/** A fetch stub returning a single canned JSON response. */
function fakeFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function tmpSecrets(): FileSecretStore {
  return new FileSecretStore(join(mkdtempSync(join(tmpdir(), "argus-secrets-")), "secrets.json"));
}

/** A Log that records each message with the level it was logged at. */
function recordingLog(): { log: Log; entries: Array<{ level: string; message: string }> } {
  const entries: Array<{ level: string; message: string }> = [];
  const at = (level: string) => (message: string) => entries.push({ level, message });
  const log = at("info") as Log;
  log.info = at("info");
  log.warn = at("warn");
  log.debug = at("debug");
  log.error = at("error");
  log.trace = at("trace");
  return { log, entries };
}

function tmpConfig(contents = "{}"): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-settings-"));
  const path = join(dir, "argus.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

const TOUCHED_ENV = ["ARGUS_DESKTOP_START_AT_LOGIN", "ARGUS_LLM_PROVIDER", "ARGUS_TASK_ENABLED", "ARGUS_LOG_LEVEL"];
afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key];
});

/** Find a described setting by its dotted path across every category/section. */
function findSetting(file: Parameters<typeof describeSettings>[0], path: string) {
  return describeSettings(file)
    .categories.flatMap((c) => c.sections)
    .flatMap((s) => s.settings)
    .find((s) => s.path === path)!;
}

describe("describeSettings", () => {
  test("groups the registry into General + Sessions categories", () => {
    const { categories } = describeSettings({});
    expect(categories.map((c) => c.id)).toEqual(["general", "sessions"]);
  });

  test("General exposes startup, auto-update plus the Argus Hub URL and a secret-backed Hub key field", () => {
    const general = describeSettings({}).categories.find((c) => c.id === "general")!;
    const paths = general.sections.flatMap((s) => s.settings).map((s) => s.path);
    expect(paths).toEqual(["desktop.startAtLogin", "autoUpdate.enabled", "hub.url", "log.level"]);
    const startAtLogin = findSetting({}, "desktop.startAtLogin");
    expect(startAtLogin.ui.control).toBe("toggle");
    expect(startAtLogin.effectiveValue).toBe(true);
    // Silent mode (#255) is config-only by design — never in the UI, even when set.
    expect(paths).not.toContain("desktop.silent");
    // The key isn't a plain (argus.json) setting — it's a fixed secret-store field under hub.url.
    expect(paths).not.toContain("hub.key");
    const hubKey = general.sections.flatMap((s) => s.secretFields ?? []).find((f) => f.key === "hub.key")!;
    expect(hubKey.secretName).toBe("ARGUS_HUB_KEY");
    expect(hubKey.providerPath).toBe("hub.url");
    expect(hubKey.secretNames).toBeUndefined(); // fixed secret, not provider-keyed
  });

  test("each setting carries its UI metadata, file value, and effective value", () => {
    const provider = findSetting({ llm: { provider: "openai" } }, "llm.provider");
    expect(provider.ui.control).toBe("select");
    const values = (provider.ui.options ?? [])
      .filter((o): o is { value: string; label: string } => o !== "separator")
      .map((o) => o.value);
    expect(values).toContain("openai");
    expect(provider.fileValue).toBe("openai");
    expect(provider.effectiveValue).toBe("openai");
    expect(provider.override).toBeUndefined();
  });

  test("provider options: pinned default, a separator, then alpha providers (no Off)", () => {
    const opts = findSetting({}, "llm.provider").ui.options ?? [];
    // The pinned default (unset), then a separator — there's no "Off" choice.
    expect(opts[0]).toEqual({ value: "", label: "Default (claude-cli)" });
    expect(opts[1]).toBe("separator");
    // The rest are real providers, alpha ascending, and never the special "off".
    const rest = opts.slice(2).filter((o): o is { value: string; label: string } => o !== "separator");
    const values = rest.map((o) => o.value);
    expect(values).not.toContain("off");
    expect(opts).not.toContainEqual({ value: "off", label: "Off" });
    expect(values).toContain("claude-cli");
    expect(values).toEqual([...values].sort());
  });

  test("LLM fields are gated on task extraction and shown per selected provider", () => {
    const provider = findSetting({}, "llm.provider");
    expect(provider.ui.label).toBe("LLM Provider");
    expect(provider.ui.activeWhen).toEqual({ path: "sessionInterpretation.enabled" });
    expect(provider.ui.effectiveDefault).toBe("claude-cli");

    // Every llm.* field shown in the UI is inactive until task extraction is on.
    for (const path of ["llm.model", "llm.command", "llm.claudeCliPath"]) {
      expect(findSetting({}, path).ui.activeWhen).toEqual({ path: "sessionInterpretation.enabled" });
    }

    // Field relevance comes from the provider registry: command is the command provider only, the
    // Claude CLI path is the claude-cli provider only, model spans most providers (but never "off").
    const visible = (path: string) => findSetting({}, path).ui.visibleWhen!;
    expect(visible("llm.command")).toEqual({ path: "llm.provider", in: ["command"] });
    expect(visible("llm.claudeCliPath")).toEqual({ path: "llm.provider", in: ["claude-cli"] });
    expect(visible("llm.model").in).toContain("claude-cli");
    expect(visible("llm.model").in).not.toContain("off");
  });

  test("provider-scoped fields carry their field id (not a value); values ship in providerConfigs", () => {
    const providerConfigs = { openai: { model: "gpt-5.4-mini" }, "claude-api": { model: "claude-sonnet-4-6" } };
    const resp = describeSettings({ llm: { provider: "openai", providerConfigs } });
    const model = resp.categories.flatMap((c) => c.sections).flatMap((s) => s.settings).find((s) => s.path === "llm.model")!;
    expect(model.providerScoped).toBe(true);
    expect(model.field).toBe("model"); // the UI builds llm.providerConfigs.<provider>.model from this
    expect(model.fileValue).toBeNull(); // no single value on the descriptor — the map is the source
    // The whole per-provider map ships so the UI can switch providers without a refetch.
    expect(resp.providerConfigs).toEqual(providerConfigs);
  });

  test("a legacy flat llm.model is folded into the active provider's config for display", () => {
    const resp = describeSettings({ llm: { provider: "claude-api", model: "legacy" } });
    expect(resp.providerConfigs?.["claude-api"]).toEqual({ model: "legacy" });
  });

  test("the Claude CLI path placeholder is the resolved binary passed in by the caller", () => {
    const find = (resp: ReturnType<typeof describeSettings>) =>
      resp.categories.flatMap((c) => c.sections).flatMap((s) => s.settings).find((s) => s.path === "llm.claudeCliPath")!;
    // Threaded in (as the serve route does) → shown as the placeholder.
    expect(find(describeSettings({}, "/usr/local/bin/claude")).placeholder).toBe("/usr/local/bin/claude");
    // Omitted (other callers) → no placeholder, and describing never resolves the binary itself.
    expect(find(describeSettings({})).placeholder).toBeUndefined();
  });

  test("the hourly interpretation cap is a number field gated on task extraction, min 1", () => {
    const s = findSetting({}, "sessionInterpretation.maxSessionsPerHour");
    expect(s.ui.control).toBe("number");
    expect(s.ui.activeWhen).toEqual({ path: "sessionInterpretation.enabled" });
    expect(s.ui.min).toBe(1);
    // It's editable through the API (in the layout), unlike the advanced CLI-only settings.
    expect(applySetting("sessionInterpretation.maxSessionsPerHour", "10", tmpConfig()).ok).toBe(true);
    // 0 (and negatives) are rejected — 0 would silently disable the drain.
    const path = tmpConfig();
    const zero = applySetting("sessionInterpretation.maxSessionsPerHour", "0", path);
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.status).toBe(400);
    expect(loadConfig(path)).toEqual({}); // not written
  });

  test("the Model field placeholder is the selected provider's default model", () => {
    const pb = findSetting({}, "llm.model").ui.placeholderByValue!;
    expect(pb.path).toBe("llm.provider");
    expect(pb.values["claude-cli"]).toBe("haiku"); // the local CLI's default
    expect(typeof pb.values["openai"]).toBe("string"); // each HTTP provider with a default
    expect(pb.values["openrouter"]).toBeUndefined(); // no default → falls back to a generic placeholder
  });

  test("max tokens and the API key env var are advanced/CLI only (not in the UI); base URL is surfaced", () => {
    const paths = describeSettings({})
      .categories.flatMap((c) => c.sections)
      .flatMap((s) => s.settings)
      .map((s) => s.path);
    expect(paths).not.toContain("llm.apiKeyEnv");
    expect(paths).not.toContain("llm.maxTokens");
    // Base URL is editable in the UI (provider-scoped, shown only for providers that use it — e.g. the
    // OpenAI provider pointed at an OpenAI-compatible server such as a LiteLLM proxy).
    expect(paths).toContain("llm.baseUrl");
  });

  test("exposes an API key secret field for the BYO-key providers", () => {
    const section = describeSettings({})
      .categories.find((c) => c.id === "sessions")!
      .sections.find((s) => (s.secretFields?.length ?? 0) > 0)!;
    const apiKey = section.secretFields![0]!;
    expect(apiKey.providerPath).toBe("llm.provider");
    expect(apiKey.activeWhen).toEqual({ path: "sessionInterpretation.enabled" });
    // Each BYO provider maps to its standard key env var; the local/off providers are absent.
    expect(apiKey.secretNames).toEqual({
      "claude-api": "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      gemini: "GEMINI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    });
    expect(apiKey.secretNames!["claude-cli"]).toBeUndefined();
  });

  test("flags an env var that overrides the file layer", () => {
    process.env.ARGUS_LLM_PROVIDER = "gemini";
    const provider = findSetting({ llm: { provider: "openai" } }, "llm.provider");
    expect(provider.fileValue).toBe("openai"); // the file still says openai
    expect(provider.effectiveValue).toBe("gemini"); // but the env var wins
    expect(provider.override).toEqual({ layer: "env", name: "ARGUS_LLM_PROVIDER" });
  });

  test("log.level is a select in General with the levels in verbosity order and info as default", () => {
    const level = findSetting({}, "log.level");
    expect(level.ui.control).toBe("select");
    expect(level.ui.label).toBe("Log level");
    // Pinned unset choice labeled with the default, a separator, then the levels least→most verbose
    // (a meaningful ranking, so not alphabetical — CLAUDE.md's UI ordering rule).
    expect(level.ui.options).toEqual([
      { value: "", label: "Default (info)" },
      "separator",
      { value: "error", label: "error" },
      { value: "warn", label: "warn" },
      { value: "info", label: "info" },
      { value: "debug", label: "debug" },
      { value: "trace", label: "trace" },
    ]);
    // Unset in the file → effective value is the built-in default.
    expect(level.fileValue).toBeNull();
    expect(level.effectiveValue).toBe("info");
    expect(level.override).toBeUndefined();
  });

  test("log.level surfaces ARGUS_LOG_LEVEL as an env override", () => {
    process.env.ARGUS_LOG_LEVEL = "debug";
    const level = findSetting({ log: { level: "warn" } }, "log.level");
    expect(level.fileValue).toBe("warn"); // the file still says warn
    expect(level.effectiveValue).toBe("debug"); // but the env var wins
    expect(level.override).toEqual({ layer: "env", name: "ARGUS_LOG_LEVEL" });
  });
});

describe("applySetting", () => {
  test("validates and writes a value to argus.json", () => {
    const path = tmpConfig();
    const result = applySetting("llm.provider", "openai", path);
    expect(result.ok).toBe(true);
    expect(loadConfig(path)).toEqual({ llm: { provider: "openai" } });
  });

  test("writes a provider-scoped field under llm.providerConfigs[provider]", () => {
    const path = tmpConfig('{"llm":{"provider":"openai"}}');
    const result = applySetting("llm.providerConfigs.openai.model", "gpt-5.4-mini", path);
    expect(result.ok).toBe(true);
    expect(loadConfig(path).llm?.providerConfigs?.openai?.model).toBe("gpt-5.4-mini");
    // A different provider's model is untouched / independent.
    applySetting("llm.providerConfigs.claude-api.model", "claude-sonnet-4-6", path);
    const cfg = loadConfig(path);
    expect(cfg.llm?.providerConfigs?.openai?.model).toBe("gpt-5.4-mini");
    expect(cfg.llm?.providerConfigs?.["claude-api"]?.model).toBe("claude-sonnet-4-6");
  });

  test("rejects a provider-scoped write to an unknown provider with a 404", () => {
    const path = tmpConfig();
    const result = applySetting("llm.providerConfigs.nonsense.model", "x", path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
    expect(loadConfig(path)).toEqual({});
  });

  test("rejects a provider-scoped write to a field the provider doesn't use", () => {
    // openai doesn't read claudeCliPath/command — persisting them would be silent junk.
    const path = tmpConfig();
    for (const field of ["claudeCliPath", "command"]) {
      const result = applySetting(`llm.providerConfigs.openai.${field}`, "/x", path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(404);
    }
    expect(loadConfig(path)).toEqual({}); // untouched
  });

  test("rejects a provider-scoped write to a reserved or off provider", () => {
    const path = tmpConfig();
    for (const prov of ["off", "hub"]) {
      const result = applySetting(`llm.providerConfigs.${prov}.model`, "x", path);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(404);
    }
    expect(loadConfig(path)).toEqual({});
  });

  test("validates and writes log.level to argus.json", () => {
    const path = tmpConfig();
    const result = applySetting("log.level", "debug", path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.setting.effectiveValue).toBe("debug");
    expect(loadConfig(path)).toEqual({ log: { level: "debug" } });
  });

  test("rejects an invalid log.level with a 400 and does not write", () => {
    const path = tmpConfig('{"log":{"level":"info"}}');
    const result = applySetting("log.level", "loud", path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    expect(loadConfig(path)).toEqual({ log: { level: "info" } }); // untouched
  });

  test("coerces a toggle value", () => {
    const path = tmpConfig();
    applySetting("sessionInterpretation.enabled", true, path);
    expect(loadConfig(path).sessionInterpretation?.enabled).toBe(true);
  });

  test("rejects a setting that isn't in the UI (e.g. max tokens) with a 404", () => {
    const path = tmpConfig();
    const result = applySetting("llm.maxTokens", "4096", path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
    expect(loadConfig(path)).toEqual({}); // untouched
  });

  test("rejects an invalid enum value with a 400 and does not write", () => {
    const path = tmpConfig('{"llm":{"provider":"openai"}}');
    const result = applySetting("llm.provider", "nonsense", path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
    // The file is untouched.
    expect(loadConfig(path)).toEqual({ llm: { provider: "openai" } });
  });

  test("rejects an unknown / non-editable setting with a 404", () => {
    const path = tmpConfig();
    const result = applySetting("hub.key", "secret", path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  test("clearing a setting removes it from the file", () => {
    const path = tmpConfig('{"llm":{"provider":"openai","model":"gpt-5"}}');
    const result = applySetting("llm.provider", "", path);
    expect(result.ok).toBe(true);
    const cfg = loadConfig(path);
    expect(cfg.llm?.provider).toBeUndefined();
    expect(cfg.llm?.model).toBe("gpt-5"); // siblings untouched
  });

  test("writes atomically (no leftover temp file)", () => {
    const path = tmpConfig();
    applySetting("llm.model", "gpt-5", path);
    // The written file is valid JSON and complete.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ llm: { model: "gpt-5" } });
  });
});

describe("testLlmConnection", () => {
  test("succeeds when the provider returns a completion", async () => {
    const configPath = tmpConfig('{"llm":{"provider":"openai","model":"gpt-5"}}');
    const secrets = tmpSecrets();
    await secrets.set("OPENAI_API_KEY", "sk-live-1234");
    const result = await testLlmConnection({
      configPath,
      secrets,
      fetch: fakeFetch({ choices: [{ message: { content: "OK" } }] }),
    });
    expect(result).toEqual({ ok: true, provider: "openai", model: "gpt-5" });
  });

  test("fails with a clear reason when the API key is missing", async () => {
    const configPath = tmpConfig('{"llm":{"provider":"openai"}}');
    const result = await testLlmConnection({
      configPath,
      secrets: tmpSecrets(), // no key stored
      fetch: fakeFetch({ choices: [] }),
    });
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("openai");
    expect(result.error).toBeTruthy(); // "No API key available…"
  });

  test("reports the provider being off rather than throwing", async () => {
    const configPath = tmpConfig('{"llm":{"provider":"off"}}');
    const result = await testLlmConnection({ configPath, secrets: tmpSecrets() });
    expect(result.ok).toBe(false);
    expect(result.provider).toBe("off");
  });

  test("logs start (INFO), the invocation (DEBUG), and success (INFO)", async () => {
    const configPath = tmpConfig('{"llm":{"provider":"openai","model":"gpt-5"}}');
    const secrets = tmpSecrets();
    await secrets.set("OPENAI_API_KEY", "sk-live-1234");
    const { log, entries } = recordingLog();
    await testLlmConnection({
      configPath,
      secrets,
      fetch: fakeFetch({ choices: [{ message: { content: "OK" } }] }),
      log,
    });
    expect(entries.some((e) => e.level === "info" && /Testing the openai/.test(e.message))).toBe(true);
    const debug = entries.find((e) => e.level === "debug");
    expect(debug?.message).toContain("provider=openai");
    expect(debug?.message).toContain("model=gpt-5");
    expect(entries.some((e) => e.level === "info" && /succeeded/.test(e.message))).toBe(true);
    // The API key must never appear in any log line.
    expect(entries.every((e) => !e.message.includes("sk-live-1234"))).toBe(true);
    expect(entries.some((e) => e.level === "warn")).toBe(false);
  });

  test("redacts command-provider contents from the connection-test debug log", async () => {
    const command = "sh -c 'printf OK' -- --token command-secret /Users/alice/private-wrapper";
    const configPath = tmpConfig(JSON.stringify({
      llm: { provider: "command", providerConfigs: { command: { command } } },
    }));
    const { log, entries } = recordingLog();

    const result = await testLlmConnection({ configPath, secrets: tmpSecrets(), log });

    expect(result.ok).toBe(true);
    const debug = entries.find((e) => e.level === "debug");
    expect(debug?.message).toContain("provider=command");
    expect(debug?.message).toContain("command=<configured>");
    expect(debug?.message).not.toContain("command-secret");
    expect(debug?.message).not.toContain("/Users/alice");
    expect(debug?.message).not.toContain("private-wrapper");
  });

  test("redacts base URL credentials, query, and fragment from the connection-test debug log", async () => {
    const configPath = tmpConfig(JSON.stringify({
      llm: {
        provider: "openai",
        providerConfigs: {
          openai: {
            model: "gpt-5",
            baseUrl: "https://user:base-url-secret@example.com/v1?api_key=query-secret#frag-secret",
          },
        },
      },
    }));
    const secrets = tmpSecrets();
    await secrets.set("OPENAI_API_KEY", "sk-live-1234");
    const { log, entries } = recordingLog();

    await testLlmConnection({
      configPath,
      secrets,
      fetch: fakeFetch({ choices: [{ message: { content: "OK" } }] }),
      log,
    });

    const debug = entries.find((e) => e.level === "debug");
    expect(debug?.message).toContain("baseUrl=https://example.com/v1");
    expect(debug?.message).not.toContain("user");
    expect(debug?.message).not.toContain("base-url-secret");
    expect(debug?.message).not.toContain("query-secret");
    expect(debug?.message).not.toContain("frag-secret");
    expect(entries.every((e) => !e.message.includes("sk-live-1234"))).toBe(true);
  });

  test("logs a WARN with the diagnostic when the test fails", async () => {
    const configPath = tmpConfig('{"llm":{"provider":"openai"}}');
    const { log, entries } = recordingLog();
    await testLlmConnection({
      configPath,
      secrets: tmpSecrets(), // no key stored
      fetch: fakeFetch({ choices: [] }),
      log,
    });
    const warn = entries.find((e) => e.level === "warn");
    expect(warn?.message).toMatch(/Connection test failed for openai/);
    expect(warn?.message).toBeTruthy();
  });
});
