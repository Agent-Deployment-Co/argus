// MDM managed settings (#257): candidate discovery, the tolerant loader (JSON + plist), and the
// managed layer's place at the top of the settings resolution chain.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPlistToJson,
  loadManagedConfig,
  managedConfigSource,
  resetManagedConfigCache,
} from "../src/managed-config.ts";
import { MANAGED_PREFS_DOMAIN, managedConfigCandidates } from "../src/paths.ts";
import {
  LLM_SETTINGS,
  managedSettingValue,
  resolveLogLevel,
  resolveSessionInterpretation,
  resolveSetting,
  type Setting,
} from "../src/config.ts";
import { describeSettings } from "../src/api/settings.ts";
import { logger } from "../src/logger.ts";

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-managed-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** Point the managed-config lookup at `path` (or nowhere) and drop the per-process cache. */
function useManagedFile(path: string | undefined): void {
  if (path === undefined) delete process.env.ARGUS_MANAGED_CONFIG_FILE;
  else process.env.ARGUS_MANAGED_CONFIG_FILE = path;
  resetManagedConfigCache();
}

afterEach(() => {
  useManagedFile(undefined);
  delete process.env.ARGUS_LLM_MODEL;
  delete process.env.ARGUS_LOG_LEVEL;
});

describe("managedConfigCandidates", () => {
  test("darwin: per-user before machine-wide, plist before json", () => {
    expect(managedConfigCandidates({}, "darwin", "someone")).toEqual([
      `/Library/Managed Preferences/someone/${MANAGED_PREFS_DOMAIN}.plist`,
      `/Library/Managed Preferences/someone/${MANAGED_PREFS_DOMAIN}.json`,
      `/Library/Managed Preferences/${MANAGED_PREFS_DOMAIN}.plist`,
      `/Library/Managed Preferences/${MANAGED_PREFS_DOMAIN}.json`,
    ]);
  });

  test("no standard locations off macOS (yet)", () => {
    expect(managedConfigCandidates({}, "linux", "someone")).toEqual([]);
    expect(managedConfigCandidates({}, "win32", "someone")).toEqual([]);
  });

  test("ARGUS_MANAGED_CONFIG_FILE is the list on platforms without standard locations", () => {
    const env = { ARGUS_MANAGED_CONFIG_FILE: "/etc/argus/managed.json" };
    expect(managedConfigCandidates(env, "linux", "someone")).toEqual(["/etc/argus/managed.json"]);
  });

  test("ARGUS_MANAGED_CONFIG_FILE is checked after standard macOS locations", () => {
    const env = { ARGUS_MANAGED_CONFIG_FILE: "/etc/argus/managed.json" };
    expect(managedConfigCandidates(env, "darwin", "someone")).toEqual([
      `/Library/Managed Preferences/someone/${MANAGED_PREFS_DOMAIN}.plist`,
      `/Library/Managed Preferences/someone/${MANAGED_PREFS_DOMAIN}.json`,
      `/Library/Managed Preferences/${MANAGED_PREFS_DOMAIN}.plist`,
      `/Library/Managed Preferences/${MANAGED_PREFS_DOMAIN}.json`,
      "/etc/argus/managed.json",
    ]);
  });

  test("an exported-but-empty override counts as absent", () => {
    expect(managedConfigCandidates({ ARGUS_MANAGED_CONFIG_FILE: "" }, "linux", "someone")).toEqual([]);
  });
});

describe("loadManagedConfig", () => {
  test("no candidates, or none that exist → undefined, no warnings", () => {
    const warnings: string[] = [];
    expect(loadManagedConfig([], (m) => warnings.push(m))).toBeUndefined();
    expect(
      loadManagedConfig([join(tmpdir(), "does-not-exist.json")], (m) => warnings.push(m)),
    ).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  test("a JSON candidate parses, and reports where it came from", () => {
    const path = tmpFile("managed.json", JSON.stringify({ log: { level: "debug" } }));
    expect(loadManagedConfig([path])).toEqual({ config: { log: { level: "debug" } }, path });
  });

  test("a malformed candidate warns and falls through to the next one", () => {
    const warnings: string[] = [];
    const bad = tmpFile("managed.json", "{ not valid json");
    const good = tmpFile("managed.json", JSON.stringify({ retainText: false }));
    const found = loadManagedConfig([bad, good], (m) => warnings.push(m));
    expect(found?.config).toEqual({ retainText: false });
    expect(found?.path).toBe(good);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(bad);
  });

  test("a non-object candidate (array/scalar) warns and is skipped", () => {
    const warnings: string[] = [];
    const path = tmpFile("managed.json", "[1, 2, 3]");
    expect(loadManagedConfig([path], (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  test("a .plist candidate goes through the plist converter", () => {
    const path = tmpFile("managed.plist", "irrelevant — the fake converter answers");
    const found = loadManagedConfig([path], () => {}, () => JSON.stringify({ log: { level: "warn" } }));
    expect(found?.config).toEqual({ log: { level: "warn" } });
  });

  test("a plist the converter rejects warns and falls through", () => {
    const warnings: string[] = [];
    const bad = tmpFile("managed.plist", "not a plist");
    const good = tmpFile("managed.json", JSON.stringify({ retainText: true }));
    const found = loadManagedConfig([bad, good], (m) => warnings.push(m), () => {
      throw new Error("plutil says no");
    });
    expect(found?.config).toEqual({ retainText: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("plutil says no");
  });

  test.if(process.platform === "darwin")("defaultPlistToJson converts a real XML plist via plutil", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>retainText</key><false/>
  <key>log</key><dict><key>level</key><string>debug</string></dict>
  <key>sessionInterpretation</key><dict><key>maxSessionsPerHour</key><integer>5</integer></dict>
</dict>
</plist>`;
    const path = tmpFile(`${MANAGED_PREFS_DOMAIN}.plist`, plist);
    expect(JSON.parse(defaultPlistToJson(path))).toEqual({
      retainText: false,
      log: { level: "debug" },
      sessionInterpretation: { maxSessionsPerHour: 5 },
    });
    // And end-to-end: the plist resolves through the managed layer.
    const found = loadManagedConfig([path]);
    expect(found?.config).toEqual({
      retainText: false,
      log: { level: "debug" },
      sessionInterpretation: { maxSessionsPerHour: 5 },
    });
  });
});

describe("managed layer precedence", () => {
  const setting: Setting<string> = {
    path: "taskExtraction.provider",
    env: "ARGUS_TASK_PROVIDER",
    flag: "task-provider",
    default: "claude",
    parse: (raw) => String(raw),
  };

  test("managed beats flag, env, and file", () => {
    useManagedFile(tmpFile("managed.json", JSON.stringify({ taskExtraction: { provider: "managed" } })));
    process.env.ARGUS_TASK_PROVIDER = "env";
    try {
      const file = { taskExtraction: { provider: "file" as never } };
      expect(resolveSetting(setting, { "task-provider": "flag" }, file)).toBe("managed");
    } finally {
      delete process.env.ARGUS_TASK_PROVIDER;
    }
  });

  test("no managed file → the usual chain is untouched", () => {
    useManagedFile(join(tmpdir(), "does-not-exist-managed.json"));
    expect(resolveSetting(setting, { "task-provider": "flag" }, {})).toBe("flag");
  });

  test("managedSettingValue reads a setting's legacyPath too", () => {
    useManagedFile(tmpFile("managed.json", JSON.stringify({ taskExtraction: { enabled: false } })));
    const resolved = resolveSessionInterpretation({ "extract-tasks": true }, { sessionInterpretation: { enabled: true } });
    expect(resolved.enabled).toBe(false);
  });

  test("resolveLogLevel: managed beats --log-level and the shorthand flags", () => {
    useManagedFile(tmpFile("managed.json", JSON.stringify({ log: { level: "error" } })));
    process.env.ARGUS_LOG_LEVEL = "trace";
    expect(resolveLogLevel({ "log-level": "trace", verbose: true }, { log: { level: "warn" } })).toBe("error");
  });

  test("provider-scoped: a managed per-provider model beats the env and file values", () => {
    useManagedFile(
      tmpFile(
        "managed.json",
        JSON.stringify({ llm: { providerConfigs: { "claude-cli": { model: "managed-model" } } } }),
      ),
    );
    process.env.ARGUS_LLM_MODEL = "env-model";
    const file = { llm: { providerConfigs: { "claude-cli": { model: "file-model" } } } };
    expect(resolveSessionInterpretation({}, file).llm.model).toBe("managed-model");
  });

  test("provider-scoped: a managed flat llm.model works too", () => {
    useManagedFile(tmpFile("managed.json", JSON.stringify({ llm: { model: "managed-flat" } })));
    process.env.ARGUS_LLM_MODEL = "env-model";
    expect(resolveSessionInterpretation({}, {}).llm.model).toBe("managed-flat");
  });

  test("shared managed llm.provider beats user-controlled per-consumer provider overrides", () => {
    useManagedFile(tmpFile("managed.json", JSON.stringify({ llm: { provider: "claude-cli" } })));
    const resolved = resolveSessionInterpretation(
      { "interpret-provider": "openai" },
      { sessionInterpretation: { provider: "gemini" } },
    );
    expect(resolved.llm.provider).toBe("claude-cli");
  });

  test("provider-scoped managed llm.model beats user-controlled per-consumer model overrides", () => {
    useManagedFile(
      tmpFile(
        "managed.json",
        JSON.stringify({ llm: { providerConfigs: { "claude-cli": { model: "managed-model" } } } }),
      ),
    );
    const resolved = resolveSessionInterpretation(
      { "interpret-model": "flag-model" },
      { sessionInterpretation: { model: "file-model" } },
    );
    expect(resolved.llm.model).toBe("managed-model");
  });

  test("an invalid managed value warns and falls through to the user layers", () => {
    useManagedFile(tmpFile("managed.json", JSON.stringify({ llm: { provider: "bogus" } })));
    const warnings: string[] = [];
    const original = logger.warn;
    logger.warn = (m?: unknown) => warnings.push(String(m));
    try {
      const resolved = resolveSessionInterpretation({}, { llm: { provider: "openai" } });
      expect(resolved.llm.provider).toBe("openai");
      expect(warnings.join("\n")).toContain("Ignoring invalid LLM provider");
    } finally {
      logger.warn = original;
    }
  });

  test("managedSettingValue is undefined for an unmanaged setting", () => {
    useManagedFile(tmpFile("managed.json", JSON.stringify({ log: { level: "warn" } })));
    expect(managedSettingValue(LLM_SETTINGS.model)).toBeUndefined();
  });

  test("the settings surface reports a managed override, naming the file", () => {
    const path = tmpFile("managed.json", JSON.stringify({ log: { level: "error" } }));
    useManagedFile(path);
    expect(managedConfigSource()?.path).toBe(path);
    const surface = describeSettings({ log: { level: "debug" } });
    const level = surface.categories
      .flatMap((c) => c.sections)
      .flatMap((s) => s.settings)
      .find((s) => s.path === "log.level");
    expect(level?.override).toEqual({ layer: "managed", name: path });
    expect(level?.effectiveValue).toBe("error");
  });

  test("the settings surface reports managed provider-scoped values", () => {
    const path = tmpFile(
      "managed.json",
      JSON.stringify({ llm: { providerConfigs: { "claude-cli": { model: "managed-model" } } } }),
    );
    useManagedFile(path);
    const surface = describeSettings({ llm: { providerConfigs: { "claude-cli": { model: "file-model" } } } });
    const model = surface.categories
      .flatMap((c) => c.sections)
      .flatMap((s) => s.settings)
      .find((s) => s.path === "llm.model");
    expect(model?.override).toEqual({ layer: "managed", name: path });
    expect(surface.providerConfigs?.["claude-cli"]?.model).toBe("managed-model");
  });
});
