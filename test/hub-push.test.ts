import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fetchUnknownSessionIds, pushHubJson, readChangedHubSessionIds, readClientId, readHubUploadPayload, readSessionIds } from "../src/push.ts";
import { STORE_APPLICATION_ID, STORE_SCHEMA_VERSION } from "../src/store/store.ts";

const TEST_CLIENT_ID = `client-${randomUUID()}`;

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
function buildArgusDb(opts: { sessionId?: string; lastTs?: number | null; version?: number; appId?: number; clientId?: string; fingerprint?: Array<{ key: string; value: string; tsMs: number }> } = {}): string {
  const sessionId = opts.sessionId ?? "sess-1";
  const lastTs = opts.lastTs === undefined ? null : opts.lastTs;
  const version = opts.version ?? STORE_SCHEMA_VERSION;
  const appId = opts.appId ?? STORE_APPLICATION_ID;
  const clientId = opts.clientId ?? TEST_CLIENT_ID;

  const path = join(tempDir(), "argus.db");
  const db = new Database(path);
  db.run(`PRAGMA application_id = ${appId}`);
  db.run(`PRAGMA user_version = ${version}`);
  db.run("CREATE TABLE store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.query("INSERT INTO store_metadata(key, value) VALUES ('client_id', ?)").run(clientId);
  db.run("CREATE TABLE client_fingerprint (key TEXT NOT NULL, value TEXT NOT NULL, ts_ms INTEGER NOT NULL, PRIMARY KEY (key, ts_ms))");
  db.run("CREATE TABLE hub_session_cursors (hub_url TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT NOT NULL, last_ts INTEGER, uploaded_at_ms INTEGER NOT NULL, PRIMARY KEY (hub_url, client_id, session_id))");
  for (const fp of opts.fingerprint ?? []) {
    db.query("INSERT INTO client_fingerprint(key, value, ts_ms) VALUES (?, ?, ?)").run(fp.key, fp.value, fp.tsMs);
  }
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
    `INSERT INTO resolved_sessions(session_id, source, project, cwd, first_ts, last_ts, message_count, meta_json)
     VALUES (?, 'claude', '/p', '/p', 1000000, ?, 1, ?)`,
  ).run(sessionId, lastTs, JSON.stringify({ sessionId, source: "claude", project: "/p", cwd: "/p" }));
  db.query(
    `INSERT INTO resolved_usage(session_id, seq, source, ts, date, cwd, project, record_json,
       input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h, model)
     VALUES (?, 0, 'claude', 1000000, '2026-01-01', '/p', '/p', ?, 100, 50, 0, 0, 0, 'claude-sonnet-4-6')`,
  ).run(sessionId, JSON.stringify({ sessionId, ts: 1_000_000 }));
  db.close();
  return path;
}

function cursorRows(path: string): Array<{ hub_url: string; client_id: string; session_id: string; last_ts: number | null }> {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ hub_url: string; client_id: string; session_id: string; last_ts: number | null }, []>(
        "SELECT hub_url, client_id, session_id, last_ts FROM hub_session_cursors ORDER BY hub_url, session_id",
      )
      .all();
  } finally {
    db.close();
  }
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

  test("includes the client_fingerprint log in the payload", () => {
    const path = buildArgusDb({
      fingerprint: [
        { key: "claude.oauth.email", value: "alice@example.com", tsMs: 1_000 },
        { key: "git.user.name", value: "Alice", tsMs: 2_000 },
      ],
    });
    const payload = readHubUploadPayload(path);
    expect(payload.fingerprint).toEqual([
      { key: "claude.oauth.email", value: "alice@example.com", tsMs: 1_000 },
      { key: "git.user.name", value: "Alice", tsMs: 2_000 },
    ]);
  });
});

describe("readClientId", () => {
  test("returns the per-install client id", () => {
    const path = buildArgusDb({ clientId: "client-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
    expect(readClientId(path)).toBe("client-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
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
      const res = await pushHubJson("http://hub.test:4242", "hub-test-key", path, { all: true });

      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);
      expect(capturedUrl).toBe("http://hub.test:4242/api/sync");
      expect(capturedHeaders["content-type"]).toBe("application/json");
      expect(capturedHeaders["authorization"]).toBe("Bearer hub-test-key");
      expect(capturedHeaders["x-argus-client"]).toBe(TEST_CLIENT_ID);
      const parsed = JSON.parse(capturedBody) as { schemaVersion: number; rows: { sessions: unknown[] }; fingerprint: unknown[] };
      expect(parsed.schemaVersion).toBe(STORE_SCHEMA_VERSION);
      expect(parsed.rows.sessions).toHaveLength(1);
      expect(parsed.fingerprint).toEqual([]);
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
      await pushHubJson("http://hub.test:4242/", "key", path, { all: true });
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
      const res = await pushHubJson("http://hub.test", "bad-key", path, { all: true });
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
      const res = await pushHubJson("http://hub.test", "hub-key", path, { all: true });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(0);
      expect(res.body).toContain("ECONNREFUSED");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false and status:0 when db file does not exist", async () => {
    const res = await pushHubJson("http://hub.test", "hub-key", "/nonexistent/path/argus.db", { all: true });
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
      const res = await fetchUnknownSessionIds("http://hub.test/", "k", TEST_CLIENT_ID, ["a", "b", "c"]);
      expect(res.ok).toBe(true);
      expect(res.unknownSessionIds).toEqual(["c"]);
      expect(capturedUrl).toBe("http://hub.test/api/sync/unknown-sessions");
      expect(capturedHeaders["authorization"]).toBe("Bearer k");
      expect(capturedHeaders["x-argus-client"]).toBe(TEST_CLIENT_ID);
      expect(JSON.parse(capturedBody)).toEqual({ sessionIds: ["a", "b", "c"] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns ok:false on a non-2xx response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: false, status: 401, text: async () => "no" }) as Response) as any;
    try {
      const res = await fetchUnknownSessionIds("http://hub.test", "k", TEST_CLIENT_ID, ["a"]);
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
      const res = await fetchUnknownSessionIds("http://hub.test", "k", TEST_CLIENT_ID, ["a"]);
      expect(res.ok).toBe(false);
      expect(res.body).toMatch(/Malformed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---- pushHubJson + cursor optimization -------------------------------------------------

interface CapturedRequest { url: string; body: any }

/** Mock fetch that captures each sync body. */
function routedFetch(
  syncResponse: { ok: boolean; status: number; body: string } = { ok: true, status: 200, body: '{"sessionsUpserted":0,"usersKnown":1}' },
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fn = (async (url: any, options: any) => {
    const u = String(url);
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ url: u, body });
    return { ok: syncResponse.ok, status: syncResponse.status, text: async () => syncResponse.body } as Response;
  }) as any;
  return { fetch: fn, calls };
}

describe("pushHubJson with client-side Hub cursors", () => {
  test("first sync uploads every session and records a cursor after success", async () => {
    const path = buildArgusDb({ sessionId: "sess-only", lastTs: 1_000_000 });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch();
    globalThis.fetch = mockFetch;
    try {
      const res = await pushHubJson("http://hub.test", "k", path);
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("http://hub.test/api/sync");
      expect(calls[0]!.body.rows.sessions).toHaveLength(1);
      expect(calls[0]!.body.rows.usage).toHaveLength(1);
      expect(cursorRows(path)).toEqual([
        { hub_url: "http://hub.test", client_id: TEST_CLIENT_ID, session_id: "sess-only", last_ts: 1_000_000 },
      ]);
      expect(readChangedHubSessionIds(path, "http://hub.test", TEST_CLIENT_ID).sessions).toEqual([]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("second sync to the same Hub uploads zero unchanged session rows", async () => {
    const path = buildArgusDb({ sessionId: "sess-known", lastTs: 2_000_000 });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch();
    globalThis.fetch = mockFetch;
    try {
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body.rows.sessions).toEqual([]);
      expect(calls[1]!.body.rows.usage).toEqual([]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("sync to a different Hub URL uploads the same session again", async () => {
    const path = buildArgusDb({ sessionId: "sess-1", lastTs: 3_000_000 });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch();
    globalThis.fetch = mockFetch;
    try {
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      expect((await pushHubJson("http://other-hub.test", "k", path)).ok).toBe(true);
      expect(calls[1]!.body.rows.sessions).toHaveLength(1);
      expect(cursorRows(path).map((row) => row.hub_url)).toEqual(["http://hub.test", "http://other-hub.test"]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("advancing last_ts causes the session to upload again", async () => {
    const path = buildArgusDb({ sessionId: "sess-1", lastTs: 4_000_000 });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch();
    globalThis.fetch = mockFetch;
    try {
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      const db = new Database(path);
      db.query("UPDATE resolved_sessions SET last_ts = ? WHERE session_id = ?").run(4_000_100, "sess-1");
      db.close();
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      expect(calls[1]!.body.rows.sessions).toHaveLength(1);
      expect(cursorRows(path)[0]!.last_ts).toBe(4_000_100);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("failed sync does not advance cursors", async () => {
    const path = buildArgusDb({ sessionId: "sess-1", lastTs: 5_000_000 });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch({ ok: false, status: 500, body: "no" });
    globalThis.fetch = mockFetch;
    try {
      const res = await pushHubJson("http://hub.test", "k", path);
      expect(res.ok).toBe(false);
      expect(res.status).toBe(500);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("http://hub.test/api/sync");
      expect(cursorRows(path)).toEqual([]);
      expect(readChangedHubSessionIds(path, "http://hub.test", TEST_CLIENT_ID).sessions).toEqual([
        { sessionId: "sess-1", lastTs: 5_000_000 },
      ]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("opts.all uploads every session and refreshes cursors", async () => {
    const path = buildArgusDb({ sessionId: "sess-1", lastTs: 6_000_000 });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch();
    globalThis.fetch = mockFetch;
    try {
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      expect((await pushHubJson("http://hub.test", "k", path, { all: true })).ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.body.rows.sessions).toHaveLength(1);
      expect(cursorRows(path)[0]!.last_ts).toBe(6_000_000);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("NULL last_ts uploads once, then skips while unchanged", async () => {
    const path = buildArgusDb({ sessionId: "sess-null", lastTs: null });
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = routedFetch();
    globalThis.fetch = mockFetch;
    try {
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      expect((await pushHubJson("http://hub.test", "k", path)).ok).toBe(true);
      expect(calls[0]!.body.rows.sessions).toHaveLength(1);
      expect(calls[1]!.body.rows.sessions).toEqual([]);
      expect(cursorRows(path)[0]!.last_ts).toBeNull();
    } finally { globalThis.fetch = originalFetch; }
  });
});
