import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetting, describeSettings } from "../src/api/settings.ts";
import { loadConfig } from "../src/config.ts";

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
  test("groups the registry into General + Session Interpretation categories", () => {
    const { categories } = describeSettings({});
    expect(categories.map((c) => c.id)).toEqual(["general", "interpretation"]);
    // General is intentionally empty for now (#154).
    expect(categories[0]!.sections).toHaveLength(0);
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

    // Every llm.* field is inactive until task extraction is on.
    for (const path of ["llm.model", "llm.baseUrl", "llm.apiKeyEnv", "llm.maxTokens", "llm.command"]) {
      expect(findSetting({}, path).ui.activeWhen).toEqual({ path: "taskExtraction.enabled" });
    }

    // Field relevance comes from the provider registry: base URL is OpenAI-only, command is the
    // command provider only, the API key var is the BYO-key HTTP providers, model spans most.
    const visible = (path: string) => findSetting({}, path).ui.visibleWhen!;
    expect(visible("llm.baseUrl")).toEqual({ path: "llm.provider", in: ["openai"] });
    expect(visible("llm.command")).toEqual({ path: "llm.provider", in: ["command"] });
    expect(visible("llm.apiKeyEnv").in).toEqual(["claude-api", "openai", "gemini", "openrouter"]);
    expect(visible("llm.model").in).toContain("claude-cli");
    expect(visible("llm.model").in).not.toContain("off");
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

  test("coerces typed values (toggle, number)", () => {
    const path = tmpConfig();
    applySetting("taskExtraction.enabled", true, path);
    applySetting("llm.maxTokens", "4096", path);
    const cfg = loadConfig(path);
    expect(cfg.taskExtraction?.enabled).toBe(true);
    expect(cfg.llm?.maxTokens).toBe(4096);
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
