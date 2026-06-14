import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite3 from "sqlite3";
import { openFactStore } from "../src/store.ts";
import { parseAll } from "../src/parse.ts";
import { cacheStatsSummary, parseAllIncrementalDetailed } from "../src/parse-incremental.ts";
import type { IncrementalCacheStats } from "../src/parse-incremental.ts";
import type { AgentSource, MessageRecord, ParseResult, ToolUse } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-incremental-"));
  tempDirs.push(dir);
  return dir;
}

function copyFixture(name: string, root: string): string {
  const target = join(root, name);
  cpSync(join(FIX, name), target, { recursive: true });
  return target;
}

function cachePath(root: string): string {
  return join(root, "cache", "fragments.sqlite3");
}

const NO_AGENTSVIEW = { agentsView: "off" as const };

function stats(overrides: Partial<IncrementalCacheStats> = {}): IncrementalCacheStats {
  return {
    hits: 0,
    parsed: 0,
    replaced: 0,
    imported: 0,
    deleted: 0,
    unstable: 0,
    failed: 0,
    incompleteDiscoveries: 0,
    fallback: false,
    ...overrides,
  };
}

function openDatabase(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
}

function exec(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function createAgentsViewCodexDb(path: string): Promise<void> {
  const db = await openDatabase(path);
  try {
    await exec(
      db,
      `
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          agent TEXT NOT NULL,
          first_message TEXT,
          cwd TEXT,
          git_branch TEXT,
          source_session_id TEXT,
          file_path TEXT,
          file_size INTEGER,
          file_mtime INTEGER,
          file_inode INTEGER,
          file_device INTEGER,
          deleted_at TEXT
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          role TEXT NOT NULL,
          timestamp TEXT,
          model TEXT,
          token_usage TEXT,
          claude_message_id TEXT,
          claude_request_id TEXT
        );
        INSERT INTO sessions VALUES (
          'codex:codex-db', 'codex', 'from agentsview', '/tmp/agentsview/codex',
          '', 'codex-db', '/tmp/codex-db.jsonl', 10, 20, 30, 40, NULL
        );
        INSERT INTO messages VALUES (
          1, 'codex:codex-db', 0, 'assistant', '2026-06-04T10:00:00Z',
          'gpt-5.5',
          '{"input_tokens":999,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}',
          '', ''
        );
      `,
    );
  } finally {
    await close(db);
  }
}

function comparable(result: ParseResult) {
  return {
    sessions: [...result.sessions.values()]
      .map((session) => ({
        source: session.source,
        sessionId: session.sessionId,
        project: session.project,
        cwd: session.cwd,
        firstPrompt: session.firstPrompt,
      }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    messages: result.messages.map((message: MessageRecord) => ({
      source: message.source,
      sessionId: message.sessionId,
      project: message.project,
      cwd: message.cwd,
      ts: message.ts,
      model: message.model,
      usage: message.usage,
      attributionSkill: message.attributionSkill,
      toolUses: message.toolUses.map((tool: ToolUse) => ({
        name: tool.name,
        skill: tool.skill,
        mcpServer: tool.mcpServer,
        mcpTool: tool.mcpTool,
        filePath: tool.filePath,
      })),
    })),
    toolResults: [...result.toolResults.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

describe("parseAllIncrementalDetailed", () => {
  test("describes cache execution modes from stats and diagnostics", () => {
    expect(cacheStatsSummary(stats({ hits: 2 }))).toStartWith("native cache:");
    expect(
      cacheStatsSummary(stats({ imported: 1 }), [
        {
          code: "agentsview_import_used",
          severity: "info",
          phase: "import",
          message: "AgentsView codex facts used because no native Argus fragments were available for that source.",
        },
      ]),
    ).toStartWith("AgentsView-assisted cache:");
    expect(
      cacheStatsSummary(stats({ hits: 2, imported: 1 }), [
        {
          code: "agentsview_import_used",
          severity: "info",
          phase: "import",
          message: "AgentsView codex facts used because no native Argus fragments were available for that source.",
        },
      ]),
    ).toStartWith("mixed native + AgentsView cache:");
    expect(cacheStatsSummary(stats({ fallback: true }))).toBe("raw parser fallback");
  });

  test("matches the native parser and reuses unchanged fragments on a second run", async () => {
    const root = tempRoot();
    const opts = {
      projectsDir: copyFixture("projects", root),
      historyFile: join(copyFixture("history.jsonl", root)),
      codexSessionsDir: copyFixture("codex-sessions", root),
      geminiDir: copyFixture("gemini", root),
      sources: ["claude", "codex", "gemini"] as AgentSource[],
      cachePath: cachePath(root),
      ...NO_AGENTSVIEW,
    };

    const native = parseAll(opts);
    const first = await parseAllIncrementalDetailed(opts);
    expect(comparable(first.parsed)).toEqual(comparable(native));
    expect(first.stats).toMatchObject({ hits: 0, parsed: 10, replaced: 10, fallback: false });

    const second = await parseAllIncrementalDetailed(opts);
    expect(comparable(second.parsed)).toEqual(comparable(native));
    expect(second.stats).toMatchObject({ hits: 10, parsed: 0, replaced: 0, fallback: false });
  });

  test("reparses a changed transcript without rebuilding unchanged sources", async () => {
    const root = tempRoot();
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const opts = {
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      cachePath: cachePath(root),
      ...NO_AGENTSVIEW,
    };

    await parseAllIncrementalDetailed(opts);
    appendFileSync(
      join(codexSessionsDir, "2026/06/03/rollout-2026-06-03T08-00-00-codex-sess1.jsonl"),
      "\n" +
        JSON.stringify({
          timestamp: "2026-06-03T13:10:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 3, output_tokens: 1 } },
          },
        }),
    );

    const changed = await parseAllIncrementalDetailed(opts);
    expect(changed.stats).toMatchObject({ hits: 0, parsed: 1, replaced: 1 });
    expect(changed.parsed.messages).toHaveLength(3);
    expect(changed.parsed.messages.at(-1)?.usage).toMatchObject({ input: 3, output: 1 });
  });

  test("a complete scan tombstones deleted files only for the selected source", async () => {
    const root = tempRoot();
    const projectsDir = copyFixture("projects", root);
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const opts = {
      projectsDir,
      codexSessionsDir,
      historyFile: join(copyFixture("history.jsonl", root)),
      sources: ["claude", "codex"] as AgentSource[],
      cachePath: cachePath(root),
      ...NO_AGENTSVIEW,
    };

    await parseAllIncrementalDetailed(opts);
    rmSync(join(codexSessionsDir, "2026/06/03/rollout-2026-06-03T08-00-00-codex-sess1.jsonl"));

    const codexOnly = await parseAllIncrementalDetailed({
      ...opts,
      sources: ["codex"],
    });
    expect(codexOnly.parsed.messages).toEqual([]);
    expect(codexOnly.stats.deleted).toBe(1);

    const cache = await openFactStore({ path: opts.cachePath });
    try {
      expect((await cache.list("claude")).filter((row) => row.status === "success").length).toBeGreaterThan(0);
      expect((await cache.list("codex")).filter((row) => row.status === "success")).toEqual([]);
    } finally {
      await cache.close();
    }
  });

  test("--no-cache uses the compatibility parser and does not create a cache", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const opts = {
      codexSessionsDir: copyFixture("codex-sessions", root),
      sources: ["codex"] as AgentSource[],
      cachePath: cachePath(root),
      noCache: true,
      ...NO_AGENTSVIEW,
    };

    const parsed = await parseAllIncrementalDetailed(opts);
    expect(parsed.stats.fallback).toBe(true);
    expect(parsed.parsed.messages).toHaveLength(2);
  });

  test("falls back to direct parsing when the cache cannot be opened", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const path = cachePath(root);
    writeFileSync(path, "not sqlite");

    const parsed = await parseAllIncrementalDetailed({
      codexSessionsDir: copyFixture("codex-sessions", root),
      sources: ["codex"] as AgentSource[],
      cachePath: path,
      ...NO_AGENTSVIEW,
    });

    expect(parsed.stats.fallback).toBe(true);
    expect(parsed.diagnostics[0]?.code).toBe("cache_fallback");
    expect(parsed.parsed.messages).toHaveLength(2);
  });

  test("imports AgentsView per session: surfaces unowned sessions, never duplicates native-owned ones", async () => {
    const root = tempRoot();
    const dbPath = join(root, "agentsview.db");
    await createAgentsViewCodexDb(dbPath);
    const opts = {
      codexSessionsDir: copyFixture("codex-sessions", root),
      sources: ["codex"] as AgentSource[],
      cachePath: cachePath(root),
      agentsViewDatabasePath: dbPath,
    };

    const native = parseAll(opts);
    const assisted = await parseAllIncrementalDetailed(opts);

    // Per-session ownership (replaces the old per-source suppression): every native-owned session is
    // preserved exactly — AgentsView never duplicates it — while the AgentsView-only session that no
    // native producer owns is now surfaced.
    expect(native.sessions.has("codex:codex-db")).toBe(false);
    for (const [sid, meta] of native.sessions) {
      expect(assisted.parsed.sessions.get(sid)).toEqual(meta);
    }
    expect(assisted.parsed.sessions.has("codex:codex-db")).toBe(true);
    expect(assisted.parsed.messages.length).toBe(native.messages.length + 1);
    expect(assisted.stats.imported).toBe(1);

    const cache = await openFactStore({ path: opts.cachePath });
    try {
      expect((await cache.list()).some((row) => row.kind === "external" && row.status === "success")).toBe(true);
    } finally {
      await cache.close();
    }
  });

  test("uses AgentsView facts when native fragments are unavailable for the source", async () => {
    const root = tempRoot();
    const dbPath = join(root, "agentsview.db");
    await createAgentsViewCodexDb(dbPath);

    const assisted = await parseAllIncrementalDetailed({
      codexSessionsDir: join(root, "missing-codex"),
      sources: ["codex"] as AgentSource[],
      cachePath: cachePath(root),
      agentsViewDatabasePath: dbPath,
    });

    expect(assisted.parsed.messages).toHaveLength(1);
    expect(assisted.parsed.messages[0]).toMatchObject({
      source: "codex",
      sessionId: "codex:codex-db",
      model: "gpt-5.5",
      usage: expect.objectContaining({ input: 999, output: 1 }),
    });
    expect(assisted.diagnostics.some((entry) => entry.code === "agentsview_import_used")).toBe(true);
  });
});

describe("materialized fact rows", () => {
  test("AgentsView-only facts round-trip and are tagged origin='external'", async () => {
    const root = tempRoot();
    const dbPath = join(root, "agentsview.db");
    await createAgentsViewCodexDb(dbPath);
    const cp = cachePath(root);

    const assisted = await parseAllIncrementalDetailed({
      codexSessionsDir: join(root, "missing-codex"),
      sources: ["codex"] as AgentSource[],
      cachePath: cp,
      agentsViewDatabasePath: dbPath,
    });
    expect(assisted.parsed.messages).toHaveLength(1);

    const db = await openDatabase(cp);
    try {
      const row = await new Promise<{ n: number }>((resolve, reject) =>
        db.get("SELECT COUNT(*) AS n FROM fact_messages WHERE origin = 'external'", (e, r) =>
          e ? reject(e) : resolve(r as { n: number }),
        ),
      );
      expect(row.n).toBeGreaterThan(0);
    } finally {
      await close(db);
    }
  });
});

describe("materialized read model", () => {
  const claudeOpts = (root: string) => ({
    projectsDir: copyFixture("projects", root),
    historyFile: join(copyFixture("history.jsonl", root)),
    sources: ["claude"] as AgentSource[],
    cachePath: cachePath(root),
    ...NO_AGENTSVIEW,
  });

  test("--since pushes down to SQL and returns the same subset as a date filter", async () => {
    const root = tempRoot();
    const opts = claudeOpts(root);
    const full = (await parseAllIncrementalDetailed(opts)).parsed;
    const dates = [...new Set(full.messages.map((m) => m.date))].sort();
    const since = dates[dates.length - 1]!; // latest day only

    const filtered = (await parseAllIncrementalDetailed({ ...opts, query: { since } })).parsed;
    const expected = full.messages.filter((m) => m.date >= since);
    expect(filtered.messages.map((m) => `${m.ts}:${m.sessionId}`)).toEqual(
      expected.map((m) => `${m.ts}:${m.sessionId}`),
    );
    // Only sessions with a surviving message remain.
    expect(new Set(filtered.sessions.keys())).toEqual(new Set(expected.map((m) => m.sessionId)));
  });

  test("--project pushes down to SQL and matches a cwd-substring filter", async () => {
    const root = tempRoot();
    const opts = claudeOpts(root);
    const full = (await parseAllIncrementalDetailed(opts)).parsed;
    const cwd = full.messages.find((m) => m.cwd)?.cwd ?? "";
    const substring = cwd.slice(0, Math.max(1, Math.floor(cwd.length / 2)));

    const filtered = (await parseAllIncrementalDetailed({ ...opts, query: { projectSubstring: substring } })).parsed;
    const expected = full.messages.filter((m) => m.cwd.includes(substring));
    expect(filtered.messages.map((m) => `${m.ts}:${m.sessionId}`)).toEqual(
      expected.map((m) => `${m.ts}:${m.sessionId}`),
    );
  });

  test("re-syncing an unchanged store is idempotent and parses nothing", async () => {
    const root = tempRoot();
    const opts = {
      codexSessionsDir: copyFixture("codex-sessions", root),
      sources: ["codex"] as AgentSource[],
      cachePath: cachePath(root),
      ...NO_AGENTSVIEW,
    };
    const first = (await parseAllIncrementalDetailed(opts)).parsed;
    const second = await parseAllIncrementalDetailed(opts);
    expect(comparable(second.parsed)).toEqual(comparable(first));
    expect(second.stats.parsed).toBe(0); // every fragment was a cache hit
  });

  test("deleting a transcript re-materializes incrementally to match a full rebuild", async () => {
    const root = tempRoot();
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const base = { codexSessionsDir, sources: ["codex"] as AgentSource[], ...NO_AGENTSVIEW };

    const incrementalPath = cachePath(root);
    await parseAllIncrementalDetailed({ ...base, cachePath: incrementalPath });
    rmSync(join(codexSessionsDir, "2026/06/03/rollout-2026-06-03T08-00-00-codex-sess1.jsonl"));
    const incremental = (await parseAllIncrementalDetailed({ ...base, cachePath: incrementalPath })).parsed;

    const rebuilt = (
      await parseAllIncrementalDetailed({ ...base, cachePath: join(root, "cache", "fresh.sqlite3") })
    ).parsed;

    expect(comparable(incremental)).toEqual(comparable(rebuilt));
  });
});
