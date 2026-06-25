import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fetchUnknownSessionIds, pushHubJson, readHubUploadPayload, readSessionIds } from "../src/push.ts";
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION } from "../src/store/store.ts";

// ---- Temp dir management ---------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "hub-push-test-"));
  tempDirs.push(d);
  return d;
}

/** Build a minimal argus.db with one session + one usage row and return its path. */
function buildArgusDb(opts: { sessionId?: string; version?: number; appId?: number } = {}): string {
  const sessionId = opts.sessionId ?? "sess-1";
  const version = opts.version ?? STORE_SCHEMA_VERSION;
  const appId = opts.appId ?? STORE_APPLICATION_ID;

  const path = join(tempDir(), "argus.db");
  const db = new Database(path);
  db.run(`PRAGMA application_id = ${appId}`);
  db.run(`PRAGMA user_version = ${version}`);
  db.run(`
    CREATE TABLE resolved_sessions (
      session_id TEXT PRIMARY KEY, source TEXT, project TEXT, cwd TEXT,
      first_ts INTEGER, last_ts INTEGER, message_count INTEGER NOT NULL DEFAULT 0,
      first_prompt TEXT, archived INTEGER NOT NULL DEFAULT 0,
      friction_interruptions INTEGER, friction_rejections INTEGER,
      friction_compactions INTEGER, friction_turns INTEGER,
      last_interruption_ms INTEGER, meta_json TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE resolved_usage (
      session_id TEXT, seq INTEGER, source TEXT, ts INTEGER, date TEXT,
      cwd TEXT, project TEXT, record_json TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER,
      cache_write_5m INTEGER, cache_write_1h INTEGER, model TEXT,
      attribution_skill TEXT, stop_reason TEXT, interaction_seq INTEGER,
      PRIMARY KEY (session_id, seq)
    )
  `);
  db.run("CREATE TABLE resolved_tasks (session_id TEXT, seq INTEGER, source TEXT, ts INTEGER, task_json TEXT, PRIMARY KEY (session_id, seq))");
  db.run("CREATE TABLE resolved_interactions (session_id TEXT, seq INTEGER, source TEXT, ts INTEGER, initiator TEXT, disposition TEXT, compaction_count INTEGER, task_seq INTEGER, interaction_json TEXT, PRIMARY KEY (session_id, seq))");
  db.run("CREATE TABLE resolved_invocations (session_id TEXT, seq INTEGER, source TEXT, interaction_seq INTEGER, tool TEXT, category TEXT, mcp_server TEXT, mcp_tool TEXT, skill TEXT, file_path TEXT, date TEXT, cwd TEXT, args TEXT, approx_result_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, seq))");
  db.query(
    `INSERT INTO resolved_sessions(session_id, source, project, cwd, message_count, meta_json)
     VALUES (?, 'claude', '/p', '/p', 1, ?)`,
  ).run(sessionId, JSON.stringify({ sessionId, source: "claude", project: "/p", cwd: "/p" }));
  db.query(
    `INSERT INTO resolved_usage(session_id, seq, source, ts, date, cwd, project, record_json,
       input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h, model)
     VALUES (?, 0, 'claude', 1000000, '2026-01-01', '/p', '/p', ?, 100, 50, 0, 0, 0, 'claude-sonnet-4-6')`,
  ).run(sessionId, JSON.stringify({ sessionId, ts: 1_000_000 }));
  db.close();
  return path;
}

// ---- readHubUploadPayload --------------------------------------------------------------

describe("readHubUploadPayload", () => {
  test("reads resolved rows from a valid argus.db", () => {
    const path = buildArgusDb({ sessionId: "sess-a" });
    const payload = readHubUploadPayload(path);
    expect(payload.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(payload.rows.sessions).toHaveLength(1);
    expect(payload.rows.sessions[0]!.session_id).toBe("sess-a");
    expect(payload.rows.usage).toHaveLength(1);
    expect(payload.rows.tasks).toEqual([]);
    expect(payload.rows.interactions).toEqual([]);
    expect(payload.rows.invocations).toEqual([]);
  });

  test("throws on a non-argus database", () => {
    const path = buildArgusDb({ appId: 0 });
    expect(() => readHubUploadPayload(path)).toThrow(/not an Argus store/);
  });
});

// ---- pushHubJson ------------------------------------------------------------------------

describe("pushHubJson", () => {
  test("POSTs JSON body with schemaVersion + rows; returns ok on 200", async () => {
    const path = buildArgusDb({ sessionId: "sess-1" });
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    globalThis.fetch = (async (url: any, options: any) => {
      capturedUrl = String(url);
      capturedHeaders = (options?.headers as Record<string, string>) ?? {};
      capturedBody = String(options?.body ?? "");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sessionsUpserted: 1, usersKnown: 1 }),
      } as Response;
    }) as any;

    try {
      const res = await pushHubJson("http://hub.test:4242", "hub-test-key", "user@example.com", path, { all: true });

      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(capturedUrl).toBe("http://hub.test:4242/api/sync");
      expect(capturedHeaders["content-type"]).toBe("application/json");
      expect(capturedHeaders["authorization"]).toBe("Bearer hub-test-key");
      expect(capturedHeaders["x-argus-user"]).toBe("user@example.com");
      const parsed = JSON.parse(capturedBody) as { schemaVersion: number; rows: { sessions: unknown[] } };
      expect(parsed.schemaVersion).toBe(STORE_SCHEMA_VERSION);
      expect(parsed.rows.sessions).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("strips trailing slash from hub url", async () => {
    const path = buildArgusDb();
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";

    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    }) as any;

    try {
      await pushHubJson("http://hub.test:4242/", "key", "user@example.com", path, { all: true });
      expect(capturedUrl).toBe("http://hub.test:4242/api/sync");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false on 401", async () => {
    const path = buildArgusDb();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => "Unauthorized" }) as Response) as any;
    try {
      const res = await pushHubJson("http://hub.test", "bad-key", "user@example.com", path, { all: true });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false and status:0 on network error", async () => {
    const path = buildArgusDb();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as any;
    try {
      const res = await pushHubJson("http://hub.test", "hub-key", "user@example.com", path, { all: true });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.body).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false and status:0 when db file does not exist", async () => {
    const res = await pushHubJson("http://hub.test", "hub-key", "user@example.com", "/nonexistent/path/argus.db", { all: true });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
  });
});

// ---- readSessionIds --------------------------------------------------------------------

describe("readSessionIds", () => {
  test("returns every session_id in resolved_sessions", () => {
    const path = buildArgusDb({ sessionId: "only-1" });
    expect(readSessionIds(path)).toEqual(["only-1"]);
  });
});

// ---- fetchUnknownSessionIds ------------------------------------------------------------

describe("fetchUnknownSessionIds", () => {
  test("POSTs sessionIds and returns the parsed unknown list", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    globalThis.fetch = (async (url: any, options: any) => {
      capturedUrl = String(url);
      capturedHeaders = (options?.headers as Record<string, string>) ?? {};
      capturedBody = String(options?.body ?? "");
      return { ok: true, status: 200, text: async () => JSON.stringify({ unknownSessionIds: ["c"] }) } as Response;
    }) as any;
    try {
      const res = await fetchUnknownSessionIds("http://hub.test/", "k", "u@x", ["a", "b", "c"]);
      expect(res.ok).toBe(true);
      expect(res.unknownSessionIds).toEqual(["c"]);
      expect(capturedUrl).toBe("http://hub.test/api/sync/unknown-sessions");
      expect(capturedHeaders["authorization"]).toBe("Bearer k");
      expect(capturedHeaders["x-argus-user"]).toBe("u@x");
      expect(JSON.parse(capturedBody)).toEqual({ sessionIds: ["a", "b", "c"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false on a non-2xx response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => "no" }) as Response) as any;
    try {
      const res = await fetchUnknownSessionIds("http://hub.test", "k", "u@x", ["a"]);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a malformed body", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ unknownSessionIds: [1, 2] }) }) as Response) as any;
    try {
      const res = await fetchUnknownSessionIds("http://hub.test", "k", "u@x", ["a"]);
      expect(res.ok).toBe(false);
      expect(res.body).toMatch(/Malformed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---- pushHubJson + probe optimization --------------------------------------------------

interface CapturedRequest { url: string; body: any }

/** Mock fetch that routes by URL: probe returns the given unknown list; sync captures the body. */
function routedFetch(
  unknownFor: (sessionIds: string[]) => string[] | { status: number; body: string },
  syncResponse: { ok: boolean; status: number; body: string } = { ok: true, status: 200, body: '{"sessionsUpserted":0,"usersKnown":1}' },
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fn = (async (url: any, options: any) => {
    const u = String(url);
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ url: u, body });
    if (u.endsWith("/api/sync/unknown-sessions")) {
      const r = unknownFor(body.sessionIds ?? []);
      if (Array.isArray(r)) return { ok: true, status: 200, text: async () => JSON.stringify({ unknownSessionIds: r }) } as Response;
      return { ok: false, status: r.status, text: async () => r.body } as Response;
    }
    return { ok: syncResponse.ok, status: syncResponse.status, text: async () => syncResponse.body } as Response;
  }) as any;
  return { fetch: fn, calls };
}

describe("pushHubJson with unknown-sessions probe", () => {
  test("probes the Hub and uploads only sessions the Hub does not have", async () => {
    const path = buildArgusDb({ sessionId: "sess-only" });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch((ids) => ids); // hub knows nothing → uploads all
    globalThis.fetch = mockFetch;
    try {
      const res = await pushHubJson("http://hub.test", "k", "u@x", path);
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.url).toBe("http://hub.test/api/sync/unknown-sessions");
      expect(calls[0]!.body).toEqual({ sessionIds: ["sess-only"] });
      expect(calls[1]!.url).toBe("http://hub.test/api/sync");
      expect(calls[1]!.body.rows.sessions).toHaveLength(1);
      expect(calls[1]!.body.rows.usage).toHaveLength(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("filters out sessions the Hub already has from the upload payload", async () => {
    const path = buildArgusDb({ sessionId: "sess-known" });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch(() => []); // hub has them all
    globalThis.fetch = mockFetch;
    try {
      const res = await pushHubJson("http://hub.test", "k", "u@x", path);
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body.rows.sessions).toEqual([]);
      expect(calls[1]!.body.rows.usage).toEqual([]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("falls back to a full upload when the probe returns 404 (older Hub)", async () => {
    const path = buildArgusDb({ sessionId: "sess-1" });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch(() => ({ status: 404, body: "Not Found" }));
    globalThis.fetch = mockFetch;
    try {
      const res = await pushHubJson("http://hub.test", "k", "u@x", path);
      expect(res.ok).toBe(true);
      expect(calls[1]!.body.rows.sessions).toHaveLength(1);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("propagates a non-404 probe failure without attempting the upload", async () => {
    const path = buildArgusDb({ sessionId: "sess-1" });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch(() => ({ status: 401, body: "no" }));
    globalThis.fetch = mockFetch;
    try {
      const res = await pushHubJson("http://hub.test", "k", "u@x", path);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(401);
      expect(calls).toHaveLength(1); // probe only — no sync POST
    } finally { globalThis.fetch = originalFetch; }
  });

  test("opts.all skips the probe entirely", async () => {
    const path = buildArgusDb({ sessionId: "sess-1" });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch(() => { throw new Error("probe should not be called"); });
    globalThis.fetch = mockFetch;
    try {
      const res = await pushHubJson("http://hub.test", "k", "u@x", path, { all: true });
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("http://hub.test/api/sync");
    } finally { globalThis.fetch = originalFetch; }
  });
});
