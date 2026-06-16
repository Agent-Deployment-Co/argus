import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PushPayloadSchema, SCHEMA_VERSION } from "@agentdeploymentco/argus-schema";
import { aggregate } from "../src/aggregate.ts";
import { parseAll } from "../src/parse.ts";
import { computeRecommendations } from "../src/recommendations.ts";
import { createApp, type Snapshot } from "../src/serve.ts";
import type { PluginInfo } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");

function fixtureSnapshot(): Snapshot {
  const parsed = parseAll({
    projectsDir: join(FIX, "projects"),
    historyFile: join(FIX, "history.jsonl"),
    codexSessionsDir: join(FIX, "codex-sessions"),
    geminiDir: join(FIX, "gemini"),
    sources: ["claude", "codex", "gemini"],
  });
  const dashboard = aggregate(parsed, new Map<string, PluginInfo>(), new Map());
  dashboard.generatedAtMs = 1_780_000_000_000;
  return { dashboard, recommendations: computeRecommendations(dashboard), generatedAtMs: dashboard.generatedAtMs };
}

describe("serve API", () => {
  test("GET /api/snapshot returns a payload whose dashboard satisfies the wire contract", async () => {
    const snap = fixtureSnapshot();
    const app = createApp(async () => snap, null);

    const res = await app.request("/api/snapshot");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Snapshot;
    expect(body.dashboard.bySource.map((s) => s.name).sort()).toEqual(["claude", "codex", "gemini"]);
    expect(Array.isArray(body.recommendations)).toBe(true);

    const payload = { schemaVersion: SCHEMA_VERSION, user: "tester@fixture.test", generatedAtMs: body.generatedAtMs, dashboard: body.dashboard };
    const result = PushPayloadSchema.safeParse(payload);
    if (!result.success) console.error(result.error.issues);
    expect(result.success).toBe(true);
  });

  test("?refresh forces a fresh build", async () => {
    let calls = 0;
    const snap = fixtureSnapshot();
    const app = createApp(async (force) => { if (force) calls++; return snap; }, null);

    await app.request("/api/snapshot");
    await app.request("/api/snapshot?refresh=1");
    expect(calls).toBe(1);
  });

  test("unknown paths fall back to the SPA (placeholder when unbuilt)", async () => {
    const app = createApp(async () => fixtureSnapshot(), null);
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
