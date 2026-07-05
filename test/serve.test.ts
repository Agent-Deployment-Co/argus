import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../src/secrets.ts";
import { createApp, type SnapshotFilters, type ViewReader, type ViewReaders } from "../src/api/serve.ts";
import type { TaskFact } from "../src/store/store-contract.ts";
import type { SessionRow } from "../src/types.ts";

/** Same-origin marker the web app sends on mutating requests (see rejectCrossSite in serve.ts). */
const SAME_ORIGIN = { headers: { "X-Argus-App": "1" }, method: "POST" } as const;

/** A full set of per-view readers for routing tests: every reader returns a marker payload; an
 *  optional `capture` records the filters each was called with. The concrete payload doesn't matter
 *  here — the folding/pricing logic lives in the builders' own unit tests (dashboard-views.test.ts). */
function makeViews(capture?: (filters: SnapshotFilters) => void): ViewReaders {
  const reader = (async (filters: SnapshotFilters) => {
    capture?.(filters);
    return { ok: true };
  }) as unknown as ViewReader<never>;
  return {
    usageDaily: reader,
    usageByModel: reader,
    usageBySource: reader,
    usageByProject: reader,
    skills: reader,
    toolsByTool: reader,
    toolsByCategory: reader,
    toolsByMcpServer: reader,
    toolsHeaviestResults: reader,
    plugins: reader,
    health: reader,
    recommendations: reader,
  };
}

const VIEW_PATHS = [
  "/api/usage/daily",
  "/api/usage/by-model",
  "/api/usage/by-source",
  "/api/usage/by-project",
  "/api/skills",
  "/api/tools/by-tool",
  "/api/tools/by-category",
  "/api/tools/by-mcp-server",
  "/api/tools/heaviest-results",
  "/api/plugins",
  "/api/health",
  "/api/recommendations",
] as const;

/** A minimal SessionRow for the /api/session/:id detail test (built inline; serve no longer carries a
 *  per-session array anywhere for tests to borrow one from). */
function fixtureSession(sessionId: string): SessionRow {
  return {
    source: "codex",
    sessionId,
    project: "web",
    start: 1,
    end: 2,
    durationMs: 1,
    messages: 1,
    userMessages: null,
    agentMessages: null,
    rawTurns: null,
    models: ["gpt-5"],
    topSkills: [],
    toolCounts: {},
    filesTouched: [],
    total: 10,
    cost: 0,
    firstPrompt: "hi",
    summary: "",
    health: {
      interruptions: null,
      rejections: null,
      compactions: null,
      turns: null,
      medianTurnMs: null,
      maxTurnMs: null,
      stopReasons: null,
      tokenGrowth: null,
    },
    tasks: [],
  };
}

describe("serve API", () => {
  test("GET /healthz answers without touching the store", async () => {
    const app = createApp(null);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("view endpoints return the reader payload and pass filters through", async () => {
    let seen: SnapshotFilters | undefined;
    const app = createApp(null, { views: makeViews((f) => { seen = f; }) });

    const res = await app.request("/api/usage/daily?since=2026-01-01&until=2026-02-01&project=web&source=codex");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual({ since: "2026-01-01", until: "2026-02-01", project: "web", source: "codex" });
  });

  test("view endpoints omit absent filters and reject an unknown source", async () => {
    let seen: SnapshotFilters | undefined;
    const app = createApp(null, { views: makeViews((f) => { seen = f; }) });

    await app.request("/api/health");
    expect(seen).toEqual({});

    expect((await app.request("/api/health?source=bogus")).status).toBe(400);
  });

  test("every view endpoint is 503 when the views aren't wired", async () => {
    const app = createApp(null);
    for (const path of VIEW_PATHS) {
      expect((await app.request(path)).status).toBe(503);
    }
  });

  test("GET /api/sessions parses pagination/sort/filters and returns the reader's page", async () => {
    let seen: unknown;
    const page = { rows: [], total: 0, offset: 5, limit: 25 };
    const app = createApp(null, {
      sessionList: async (query) => { seen = query; return page; },
    });

    const res = await app.request("/api/sessions?sort=tokens&limit=25&offset=5&source=codex&project=web&q=fix&includeGenerated=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(page);
    expect(seen).toEqual({
      sort: "tokens", limit: 25, offset: 5, source: "codex",
      project: "web", q: "fix", includeGenerated: true, since: undefined, until: undefined,
    });
  });

  test("GET /api/sessions clamps limit and rejects an unknown sort", async () => {
    let seen: { limit?: number } = {};
    const app = createApp(null, {
      sessionList: async (query) => { seen = query; return { rows: [], total: 0, offset: 0, limit: query.limit }; },
    });
    await app.request("/api/sessions?limit=9999");
    expect(seen.limit).toBe(200); // clamped to MAX_SESSION_LIMIT

    const bad = await app.request("/api/sessions?sort=bogus");
    expect(bad.status).toBe(400);
  });

  test("GET /api/sessions is 503 when the reader is not wired", async () => {
    const app = createApp(null);
    expect((await app.request("/api/sessions")).status).toBe(503);
  });

  test("GET /api/session/:id returns detail, 404 for unknown, 503 when unwired", async () => {
    const known = fixtureSession("codex:codex-sess1");
    const app = createApp(null, {
      sessionDetail: async (id) => (id === known.sessionId ? known : null),
    });

    const ok = await app.request(`/api/session/${encodeURIComponent(known.sessionId)}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).session.sessionId).toBe(known.sessionId);

    expect((await app.request("/api/session/nope")).status).toBe(404);

    const unwired = createApp(null);
    expect((await unwired.request("/api/session/x")).status).toBe(503);
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
    const logs: string[] = [];
    const app = createApp(null, {
      reindex: async (sessionId) => ({ ok: true, tasks: [{ ...task, sourceSessionId: sessionId }], diagnostics: [] }),
      onStoreChanged: () => { changed++; },
      log: (message) => { logs.push(message); },
    });

    const res = await app.request("/api/sessions/codex:codex-sess1/reindex", SAME_ORIGIN);
    expect(res.status).toBe(200);
    expect(changed).toBe(1);
    expect(logs).toEqual([
      "Refreshing codex:codex-sess1: re-reading the session and rebuilding tasks...",
      "Refreshed codex:codex-sess1: rebuilt 1 task.",
    ]);
    expect(await res.json()).toEqual({
      tasks: [{ ...task, sourceSessionId: "codex:codex-sess1" }],
      diagnostics: [],
    });
  });

  test("POST /api/sessions/:id/reindex returns a clear error when the transcript is gone", async () => {
    let changed = 0;
    const logs: string[] = [];
    const app = createApp(null, {
      reindex: async () => ({ ok: false, status: 422, message: "Couldn't re-index missing: it has no local transcript on disk." }),
      onStoreChanged: () => { changed++; },
      log: (message) => { logs.push(message); },
    });

    const res = await app.request("/api/sessions/missing/reindex", SAME_ORIGIN);
    expect(res.status).toBe(422);
    expect(changed).toBe(0);
    expect(logs).toEqual([
      "Refreshing missing: re-reading the session and rebuilding tasks...",
      "Refresh failed for missing: Couldn't re-index missing: it has no local transcript on disk.",
    ]);
    expect(await res.json()).toEqual({
      error: "Couldn't re-index missing: it has no local transcript on disk.",
      diagnostics: [],
    });
  });

  test("POST /api/sessions/:id/reindex surfaces a 404 for an unknown session", async () => {
    const app = createApp(null, {
      reindex: async () => ({ ok: false, status: 404, message: "No session found for missing." }),
    });

    const res = await app.request("/api/sessions/missing/reindex", SAME_ORIGIN);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No session found for missing.", diagnostics: [] });
  });

  test("POST /api/sessions/:id/reindex is 503 when reindexing isn't wired up", async () => {
    const app = createApp(null);
    const res = await app.request("/api/sessions/whatever/reindex", SAME_ORIGIN);
    expect(res.status).toBe(503);
  });

  test("POST /api/sessions/:id/reindex rejects cross-site requests (CSRF guard)", async () => {
    let changed = 0;
    const app = createApp(null, {
      reindex: async () => ({ ok: true, tasks: [], diagnostics: [] }) as never,
      onStoreChanged: () => { changed++; },
    });

    // No same-origin marker → blocked before reindex runs.
    const bare = await app.request("/api/sessions/codex:sess1/reindex", { method: "POST" });
    expect(bare.status).toBe(403);

    // A cross-site Sec-Fetch-Site is rejected even if the marker were present.
    const crossSite = await app.request("/api/sessions/codex:sess1/reindex", {
      method: "POST",
      headers: { "X-Argus-App": "1", "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);

    expect(changed).toBe(0);
  });

  test("GET /api/sessions/:id/task-metrics returns per-task metrics keyed by task id", async () => {
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
    const app = createApp(null, {
      sessionTaskMetrics: async (sessionId) => {
        gotSession = sessionId;
        return { "fact:task:abc": metrics };
      },
    });

    const res = await app.request("/api/sessions/codex:sess1/task-metrics");
    expect(res.status).toBe(200);
    expect(gotSession).toBe("codex:sess1");
    expect(await res.json()).toEqual({ metrics: { "fact:task:abc": metrics } });
  });

  test("GET /api/sessions/:id/task-metrics is 503 when metrics aren't wired up", async () => {
    const app = createApp(null);
    const res = await app.request("/api/sessions/s/task-metrics");
    expect(res.status).toBe(503);
  });

  test("GET /api/debug returns the injected debug payload (503 when unwired)", async () => {
    const unwired = createApp(null);
    expect((await unwired.request("/api/debug")).status).toBe(503);

    const payload = { generatedAtMs: 1, version: { argus: "9.9.9", storeSchema: 8 } };
    const app = createApp(null, {
      debugInfo: async () => payload as never,
    });
    const res = await app.request("/api/debug");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });

  test("unknown paths fall back to the SPA (placeholder when unbuilt)", async () => {
    const app = createApp(null);
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("secret settings endpoints (#132)", () => {
  // A file-backed store in a temp dir so the test never touches the real keychain.
  function appWithSecrets() {
    const dir = mkdtempSync(join(tmpdir(), "argus-serve-secrets-"));
    const store = new FileSecretStore(join(dir, "secrets.json"));
    return createApp(null, { secrets: store });
  }
  // A same-origin POST carrying a JSON body (the app header + loopback Host).
  const post = (value: unknown) => ({
    method: "POST",
    headers: { "X-Argus-App": "1", Host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
  const getHeaders = { headers: { "X-Argus-App": "1", Host: "localhost" } };

  test("write then masked read; the value never comes back", async () => {
    const app = appWithSecrets();
    const write = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", post("sk-supersecret-WXYZ"));
    expect(write.status).toBe(200);
    const writeBody = await write.json();
    expect(writeBody).toEqual({ configured: true, hint: "…WXYZ" });
    expect(JSON.stringify(writeBody)).not.toContain("supersecret");

    const read = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", getHeaders);
    expect(await read.json()).toEqual({ configured: true, hint: "…WXYZ" });
  });

  test("unconfigured secret reports not configured", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/OPENAI_API_KEY", getHeaders);
    expect(await res.json()).toEqual({ configured: false });
  });

  test("the Argus Hub key is an allowed secret (write then masked read)", async () => {
    const app = appWithSecrets();
    const write = await app.request("/api/settings/secrets/ARGUS_HUB_KEY", post("hub-secret-WXYZ"));
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ configured: true, hint: "…WXYZ" });
  });

  test("rejects a non-allowlisted secret name", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/HOME", post("x"));
    expect(res.status).toBe(400);
  });

  test("rejects a write missing the same-origin app header (CSRF)", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", {
      method: "POST",
      headers: { Host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects a non-loopback Host (DNS rebinding)", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", {
      method: "POST",
      headers: { "X-Argus-App": "1", Host: "evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("accepts IPv6 loopback Host, bracketed-with-port and bare", async () => {
    for (const host of ["[::1]:4242", "::1"]) {
      const app = appWithSecrets();
      const res = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", {
        method: "POST",
        headers: { "X-Argus-App": "1", Host: host, "content-type": "application/json" },
        body: JSON.stringify({ value: "sk-x" }),
      });
      expect(res.status).toBe(200);
    }
  });

  test("rejects a cross-origin Origin", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", {
      method: "POST",
      headers: {
        "X-Argus-App": "1",
        Host: "localhost",
        Origin: "https://evil.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects an empty value", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", post("   "));
    expect(res.status).toBe(400);
  });

  const del = { method: "DELETE", headers: { "X-Argus-App": "1", Host: "localhost" } } as const;

  test("DELETE removes a stored key and reports not configured", async () => {
    const app = appWithSecrets();
    await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", post("sk-to-remove-1234"));
    expect(await (await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", getHeaders)).json()).toEqual({
      configured: true,
      hint: "…1234",
    });
    const removed = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", del);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ configured: false });
    // Reading it back confirms it's gone.
    expect(await (await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", getHeaders)).json()).toEqual({
      configured: false,
    });
  });

  test("DELETE on an absent key is idempotent (still not configured)", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/OPENAI_API_KEY", del);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });

  test("DELETE requires the same-origin app header (CSRF)", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", {
      method: "DELETE",
      headers: { Host: "localhost" },
    });
    expect(res.status).toBe(403);
  });

  test("DELETE rejects a non-loopback Host (DNS rebinding)", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/ANTHROPIC_API_KEY", {
      method: "DELETE",
      headers: { "X-Argus-App": "1", Host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("DELETE rejects a non-allowlisted secret name", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/secrets/HOME", del);
    expect(res.status).toBe(400);
  });

  // The test-connection route reads config + the stored key and runs a live completion. We only check
  // its guards + the no-network "off" path here; the completion logic is unit-tested in settings.test.
  test("test-connection requires the same-origin app header (CSRF)", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/test-connection", { method: "POST", headers: { Host: "localhost" } });
    expect(res.status).toBe(403);
  });

  test("test-connection rejects a non-loopback Host (DNS rebinding)", async () => {
    const app = appWithSecrets();
    const res = await app.request("/api/settings/test-connection", {
      method: "POST",
      headers: { "X-Argus-App": "1", Host: "evil.example.com" },
    });
    expect(res.status).toBe(403);
  });
});

describe("settings endpoints (#154)", () => {
  // A temp argus.json so the test never touches the real config.
  function appWithConfig(contents = "{}") {
    const dir = mkdtempSync(join(tmpdir(), "argus-serve-settings-"));
    const configPath = join(dir, "argus.json");
    writeFileSync(configPath, contents, "utf8");
    return { app: createApp(null, { configPath }), configPath };
  }
  const put = (value: unknown) => ({
    method: "PUT",
    headers: { "X-Argus-App": "1", Host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });

  test("GET returns the registry-driven categories", async () => {
    const { app } = appWithConfig();
    const res = await app.request("/api/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { categories: { id: string }[] };
    expect(body.categories.map((c) => c.id)).toEqual(["general", "sessions"]);
  });

  test("PUT validates and writes a setting", async () => {
    const { app, configPath } = appWithConfig();
    const res = await app.request("/api/settings/llm.provider", put("openai"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { setting: { fileValue: unknown } };
    expect(body.setting.fileValue).toBe("openai");
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ llm: { provider: "openai" } });
  });

  test("PUT rejects an invalid value with 400", async () => {
    const { app } = appWithConfig();
    const res = await app.request("/api/settings/llm.provider", put("nonsense"));
    expect(res.status).toBe(400);
  });

  test("PUT rejects a non-editable setting with 404", async () => {
    const { app } = appWithConfig();
    const res = await app.request("/api/settings/hub.key", put("secret"));
    expect(res.status).toBe(404);
  });

  test("PUT requires the same-origin app header (CSRF)", async () => {
    const { app } = appWithConfig();
    const res = await app.request("/api/settings/llm.provider", {
      method: "PUT",
      headers: { Host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ value: "openai" }),
    });
    expect(res.status).toBe(403);
  });

  test("PUT rejects a non-loopback Host (DNS rebinding)", async () => {
    const { app } = appWithConfig();
    const res = await app.request("/api/settings/llm.provider", {
      method: "PUT",
      headers: { "X-Argus-App": "1", Host: "evil.example.com", "content-type": "application/json" },
      body: JSON.stringify({ value: "openai" }),
    });
    expect(res.status).toBe(403);
  });
});
