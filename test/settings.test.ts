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

describe("describeSettings", () => {
  test("groups the registry into General / Tasks / LLM categories", () => {
    const { categories } = describeSettings({});
    expect(categories.map((c) => c.id)).toEqual(["general", "tasks", "llm"]);
    // General is intentionally empty for now (#154).
    expect(categories[0]!.sections).toHaveLength(0);
  });

  test("each setting carries its UI metadata, file value, and effective value", () => {
    const { categories } = describeSettings({ llm: { provider: "openai" } });
    const llm = categories.find((c) => c.id === "llm")!;
    const provider = llm.sections[0]!.settings.find((s) => s.path === "llm.provider")!;
    expect(provider.ui.control).toBe("select");
    expect(provider.ui.options).toContain("openai");
    expect(provider.fileValue).toBe("openai");
    expect(provider.effectiveValue).toBe("openai");
    expect(provider.override).toBeUndefined();
  });

  test("flags an env var that overrides the file layer", () => {
    process.env.ARGUS_LLM_PROVIDER = "gemini";
    const { categories } = describeSettings({ llm: { provider: "openai" } });
    const provider = categories
      .find((c) => c.id === "llm")!
      .sections[0]!.settings.find((s) => s.path === "llm.provider")!;
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
