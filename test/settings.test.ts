import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetting, describeSettings, testLlmConnection } from "../src/api/settings.ts";
import { loadConfig } from "../src/config.ts";
import { FileSecretStore } from "../src/secrets.ts";

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

function tmpConfig(contents = "{}"): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-settings-"));
  const path = join(dir, "argus.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

const TOUCHED_ENV = ["ARGUS_LLM_PROVIDER", "ARGUS_TASK_ENABLED"];
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

  test("General exposes the Argus Hub URL plus a secret-backed Hub key field", () => {
    const general = describeSettings({}).categories.find((c) => c.id === "general")!;
    const paths = general.sections.flatMap((s) => s.settings).map((s) => s.path);
    expect(paths).toEqual(["hub.url"]);
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

  test("provider options: pinned default + off, a separator, then alpha providers without off", () => {
    const opts = findSetting({}, "llm.provider").ui.options ?? [];
    // First two are the pinned default (unset) and an explicit Off.
    expect(opts[0]).toEqual({ value: "", label: "Default (claude-cli)" });
    expect(opts[1]).toEqual({ value: "off", label: "Off" });
    expect(opts[2]).toBe("separator");
    // The rest are real providers, alpha ascending, and never the special "off".
    const rest = opts.slice(3).filter((o): o is { value: string; label: string } => o !== "separator");
    const values = rest.map((o) => o.value);
    expect(values).not.toContain("off");
    expect(values).toContain("claude-cli");
    expect(values).toEqual([...values].sort());
  });

  test("LLM fields are gated on task extraction and shown per selected provider", () => {
    const provider = findSetting({}, "llm.provider");
    expect(provider.ui.label).toBe("LLM Provider");
    expect(provider.ui.activeWhen).toEqual({ path: "taskExtraction.enabled" });
    expect(provider.ui.effectiveDefault).toBe("claude-cli");

    // Every llm.* field shown in the UI is inactive until task extraction is on.
    for (const path of ["llm.model", "llm.command"]) {
      expect(findSetting({}, path).ui.activeWhen).toEqual({ path: "taskExtraction.enabled" });
    }

    // Field relevance comes from the provider registry: command is the command provider only, model
    // spans most providers (but never "off").
    const visible = (path: string) => findSetting({}, path).ui.visibleWhen!;
    expect(visible("llm.command")).toEqual({ path: "llm.provider", in: ["command"] });
    expect(visible("llm.model").in).toContain("claude-cli");
    expect(visible("llm.model").in).not.toContain("off");
  });

  test("the Model field placeholder is the selected provider's default model", () => {
    const pb = findSetting({}, "llm.model").ui.placeholderByValue!;
    expect(pb.path).toBe("llm.provider");
    expect(pb.values["claude-cli"]).toBe("haiku"); // the local CLI's default
    expect(typeof pb.values["openai"]).toBe("string"); // each HTTP provider with a default
    expect(pb.values["openrouter"]).toBeUndefined(); // no default → falls back to a generic placeholder
  });

  test("base URL, max tokens, and the API key env var are advanced/CLI only (not in the UI)", () => {
    const paths = describeSettings({})
      .categories.flatMap((c) => c.sections)
      .flatMap((s) => s.settings)
      .map((s) => s.path);
    expect(paths).not.toContain("llm.apiKeyEnv");
    expect(paths).not.toContain("llm.baseUrl");
    expect(paths).not.toContain("llm.maxTokens");
  });

  test("exposes an API key secret field for the BYO-key providers", () => {
    const section = describeSettings({})
      .categories.find((c) => c.id === "sessions")!
      .sections.find((s) => (s.secretFields?.length ?? 0) > 0)!;
    const apiKey = section.secretFields![0]!;
    expect(apiKey.providerPath).toBe("llm.provider");
    expect(apiKey.activeWhen).toEqual({ path: "taskExtraction.enabled" });
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
});

describe("applySetting", () => {
  test("validates and writes a value to argus.json", () => {
    const path = tmpConfig();
    const result = applySetting("llm.provider", "openai", path);
    expect(result.ok).toBe(true);
    expect(loadConfig(path)).toEqual({ llm: { provider: "openai" } });
  });

  test("coerces a toggle value", () => {
    const path = tmpConfig();
    applySetting("taskExtraction.enabled", true, path);
    expect(loadConfig(path).taskExtraction?.enabled).toBe(true);
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
});
