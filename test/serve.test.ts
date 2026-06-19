import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PushPayloadSchema, SCHEMA_VERSION } from "@agentdeploymentco/argus-schema";
import { aggregate } from "../src/aggregate.ts";
import { parseAll } from "../src/parse.ts";
import { computeRecommendations } from "../src/recommendations.ts";
import { createApp, type Snapshot } from "../src/serve.ts";
import type { TaskFact } from "../src/store-contract.ts";
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

  test("POST /api/sessions/:id/reindex returns tasks and reports that the store changed", async () => {
    const task: TaskFact = {
      id: "task:fixture",
      source: "codex",
      sourceSessionId: "codex:codex-sess1",
      timestampMs: 1,
      description: "Extract tasks from the session screen",
      evidence: "message indexes: 0",
      evidenceKind: "llm_inference",
      position: { originKey: "fixture", recordIndex: 0, itemIndex: 0 },
    };
    let changed = 0;
    const app = createApp(async () => fixtureSnapshot(), null, {
      reindex: async (sessionId) => ({ ok: true, tasks: [{ ...task, sourceSessionId: sessionId }], diagnostics: [] }),
      onStoreChanged: () => { changed++; },
    });

    const res = await app.request("/api/sessions/codex:codex-sess1/reindex", { method: "POST" });
    expect(res.status).toBe(200);
    expect(changed).toBe(1);
    expect(await res.json()).toEqual({
      tasks: [{ ...task, sourceSessionId: "codex:codex-sess1" }],
      diagnostics: [],
    });
  });

  test("POST /api/sessions/:id/reindex returns a clear error when the transcript is gone", async () => {
    let changed = 0;
    const app = createApp(async () => fixtureSnapshot(), null, {
      reindex: async () => ({ ok: false, status: 422, message: "Couldn't re-index missing: it has no local transcript on disk." }),
      onStoreChanged: () => { changed++; },
    });

    const res = await app.request("/api/sessions/missing/reindex", { method: "POST" });
    expect(res.status).toBe(422);
    expect(changed).toBe(0);
    expect(await res.json()).toEqual({
      error: "Couldn't re-index missing: it has no local transcript on disk.",
      diagnostics: [],
    });
  });

  test("POST /api/sessions/:id/reindex surfaces a 404 for an unknown session", async () => {
    const app = createApp(async () => fixtureSnapshot(), null, {
      reindex: async () => ({ ok: false, status: 404, message: "No session found for missing." }),
    });

    const res = await app.request("/api/sessions/missing/reindex", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No session found for missing.", diagnostics: [] });
  });

  test("POST /api/sessions/:id/reindex is 503 when reindexing isn't wired up", async () => {
    const app = createApp(async () => fixtureSnapshot(), null);
    const res = await app.request("/api/sessions/whatever/reindex", { method: "POST" });
    expect(res.status).toBe(503);
  });

  test("GET /api/sessions/:id/tasks/:taskId returns the task's metrics", async () => {
    const metrics = {
      messages: 3,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      totalTokens: 15,
      cost: 0.01,
      toolCalls: 2,
      toolCounts: { Bash: 2 },
      models: ["claude-sonnet-4-5"],
    };
    let gotSession = "";
    let gotTask = "";
    const app = createApp(async () => fixtureSnapshot(), null, {
      taskMetrics: async (sessionId, taskId) => {
        gotSession = sessionId;
        gotTask = taskId;
        return metrics;
      },
    });

    const res = await app.request("/api/sessions/codex:sess1/tasks/fact:task:abc");
    expect(res.status).toBe(200);
    expect(gotSession).toBe("codex:sess1");
    expect(gotTask).toBe("fact:task:abc");
    expect(await res.json()).toEqual({ metrics });
  });

  test("GET /api/sessions/:id/tasks/:taskId is 404 for an unknown task", async () => {
    const app = createApp(async () => fixtureSnapshot(), null, {
      taskMetrics: async () => undefined,
    });
    const res = await app.request("/api/sessions/s/tasks/missing");
    expect(res.status).toBe(404);
  });

  test("GET /api/sessions/:id/tasks/:taskId is 503 when metrics aren't wired up", async () => {
    const app = createApp(async () => fixtureSnapshot(), null);
    const res = await app.request("/api/sessions/s/tasks/whatever");
    expect(res.status).toBe(503);
  });

  test("unknown paths fall back to the SPA (placeholder when unbuilt)", async () => {
    const app = createApp(async () => fixtureSnapshot(), null);
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
