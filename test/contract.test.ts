import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PushPayloadSchema, SCHEMA_VERSION } from "@agentdeploymentco/argus-schema";
import { aggregate } from "../src/aggregate.ts";
import { parseAll } from "../src/parse.ts";
import type { PluginInfo } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");

// The most important cross-repo test: what the CLI actually produces must satisfy the shared
// wire contract. Catches drift between the CLI's aggregate output and @agentdeploymentco/argus-schema.
describe("CLI output ↔ wire contract", () => {
  test("an aggregated dashboard validates against PushPayloadSchema", () => {
    const parsed = parseAll({
      projectsDir: join(FIX, "projects"),
      historyFile: join(FIX, "history.jsonl"),
      codexSessionsDir: join(FIX, "codex-sessions"),
      geminiDir: join(FIX, "gemini"),
      sources: ["claude", "codex", "gemini"],
    });
    const dash = aggregate(parsed, new Map<string, PluginInfo>(), new Map());
    dash.generatedAtMs = 1_780_000_000_000;
    expect(dash.bySource.map((s) => s.name).sort()).toEqual(["claude", "codex", "gemini"]);
    expect(dash.sessions.every((s) => ["claude", "codex", "gemini"].includes(s.source))).toBe(true);

    const payload = { schemaVersion: SCHEMA_VERSION, org: "fixture.test", user: "tester@fixture.test", generatedAtMs: dash.generatedAtMs, dashboard: dash };
    const result = PushPayloadSchema.safeParse(payload);
    if (!result.success) console.error(result.error.issues);
    expect(result.success).toBe(true);
  });
});
