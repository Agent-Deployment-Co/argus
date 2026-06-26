import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPath,
  loadConfig,
  resolveSetting,
  resolveTaskExtraction,
  type Setting,
} from "../src/config.ts";

function tmpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-config-"));
  const path = join(dir, "argus.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

const TASK_ENV = [
  "ARGUS_TASK_ENABLED",
  "ARGUS_TASK_PROVIDER",
  "ARGUS_TASK_MODEL",
  "ARGUS_TASK_PROMPT",
  "ARGUS_TASK_PROMPT_FILE",
  "ARGUS_TASK_COMMAND",
];

afterEach(() => {
  for (const key of TASK_ENV) delete process.env[key];
});

describe("loadConfig", () => {
  test("missing file → defaults, no warning", () => {
    const warnings: string[] = [];
    const cfg = loadConfig(join(tmpdir(), "does-not-exist-argus.json"), (m) => warnings.push(m));
    expect(cfg).toEqual({});
    expect(warnings).toHaveLength(0);
  });

  test("valid file → parsed object", () => {
    const path = tmpConfig(JSON.stringify({ taskExtraction: { enabled: true, provider: "claude" } }));
    expect(loadConfig(path)).toEqual({ taskExtraction: { enabled: true, provider: "claude" } });
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

describe("resolveTaskExtraction", () => {
  test("acceptance #89: file enables extraction with no flags", () => {
    const file = { taskExtraction: { enabled: true, provider: "claude" as const } };
    const resolved = resolveTaskExtraction({}, file);
    expect(resolved.enabled).toBe(true);
    expect(resolved.llm.provider).toBe("claude");
  });

  test("empty config → today's defaults (disabled, provider claude, no extras)", () => {
    const resolved = resolveTaskExtraction({}, {});
    expect(resolved.enabled).toBe(false);
    expect(resolved.llm.provider).toBe("claude");
    expect(resolved.llm.model).toBeUndefined();
    expect(resolved.llm.command).toBeUndefined();
  });

  test("env var enables and overrides file provider", () => {
    process.env.ARGUS_TASK_ENABLED = "true";
    process.env.ARGUS_TASK_PROVIDER = "command";
    const file = { taskExtraction: { enabled: false, provider: "claude" as const } };
    const resolved = resolveTaskExtraction({}, file);
    expect(resolved.enabled).toBe(true);
    expect(resolved.llm.provider).toBe("command");
  });

  test("#93: --extract-tasks false forces off even when the file enables it", () => {
    const file = { taskExtraction: { enabled: true } };
    expect(resolveTaskExtraction({ "extract-tasks": false }, file).enabled).toBe(false);
    expect(resolveTaskExtraction({ "extract-tasks": true }, { taskExtraction: { enabled: false } }).enabled).toBe(true);
    // Unset (omitted) defers to the file.
    expect(resolveTaskExtraction({}, file).enabled).toBe(true);
  });

  test("flag overrides env and file", () => {
    process.env.ARGUS_TASK_PROVIDER = "command";
    const resolved = resolveTaskExtraction(
      { "task-provider": "off", "task-model": "haiku" },
      { taskExtraction: { provider: "claude" } },
    );
    expect(resolved.llm.provider).toBe("off");
    expect(resolved.llm.model).toBe("haiku");
  });

  test("boolean coercion of string env/file values", () => {
    expect(resolveTaskExtraction({}, { taskExtraction: { enabled: true } }).enabled).toBe(true);
    process.env.ARGUS_TASK_ENABLED = "0";
    expect(resolveTaskExtraction({}, {}).enabled).toBe(false);
  });

  test("an invalid provider warns and falls back instead of hard-exiting (#89 tolerant)", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m?: unknown) => warnings.push(String(m));
    try {
      // A typo in argus.json must not kill an unrelated `index`/`serve`/`run`.
      const resolved = resolveTaskExtraction({}, { taskExtraction: { provider: "cluade" as never } });
      expect(resolved.llm.provider).toBe("claude");
      expect(warnings.join("\n")).toContain("Ignoring invalid LLM provider");
    } finally {
      console.warn = original;
    }
  });

  test("an exported-but-empty env var is treated as unset, not a value", () => {
    process.env.ARGUS_TASK_PROVIDER = "";
    // "" must fall through to the file rather than route through provider validation.
    expect(resolveTaskExtraction({}, { taskExtraction: { provider: "command" } }).llm.provider).toBe("command");
  });

  test("reattaches debugLog (not a persisted setting)", () => {
    const sink = () => {};
    expect(resolveTaskExtraction({}, {}, sink).debugLog).toBe(sink);
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
      llm: { provider: "anthropic" as const, model: "claude-haiku-4-5", maxTokens: 4096, baseUrl: "http://x" },
    };
    const resolved = resolveTaskExtraction({}, file);
    expect(resolved.llm).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      maxTokens: 4096,
      baseUrl: "http://x",
      apiKeyEnv: "ANTHROPIC_API_KEY", // defaulted from the provider
    });
  });

  test("apiKeyEnv defaults per provider but an explicit value wins", () => {
    expect(resolveTaskExtraction({}, { llm: { provider: "openai" } }).llm.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(resolveTaskExtraction({}, { llm: { provider: "gemini" } }).llm.apiKeyEnv).toBe("GEMINI_API_KEY");
    expect(
      resolveTaskExtraction({}, { llm: { provider: "openai", apiKeyEnv: "MY_KEY" } }).llm.apiKeyEnv,
    ).toBe("MY_KEY");
  });

  test("the deprecated taskExtraction.provider overrides the shared llm.provider", () => {
    const file = { llm: { provider: "anthropic" as const }, taskExtraction: { provider: "claude" as const } };
    expect(resolveTaskExtraction({}, file).llm.provider).toBe("claude");
  });

  test("local providers carry no apiKeyEnv", () => {
    expect(resolveTaskExtraction({}, { llm: { provider: "claude" } }).llm.apiKeyEnv).toBeUndefined();
  });
});
