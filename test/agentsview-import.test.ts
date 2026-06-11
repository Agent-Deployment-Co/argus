import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sqlite3 from "sqlite3";
import {
  AgentsViewImporter,
  agentsViewDatabasePath,
} from "../src/agentsview-import.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function createFixture(includeToolCalls = true): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "argus-agentsview-"));
  tempDirs.push(dir);
  const path = join(dir, "sessions.db");
  const db = await openDatabase(path);
  await exec(
    db,
    `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        project TEXT,
        first_message TEXT,
        started_at TEXT,
        ended_at TEXT,
        parent_session_id TEXT,
        relationship_type TEXT,
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
      INSERT INTO sessions VALUES
        ('claude-parent', 'claude', 'fixture/proj', 'hello', '2026-06-01T10:00:00Z',
         '2026-06-01T10:05:00Z', NULL, '', '/tmp/fixture/proj', 'main', 'claude-parent',
         '/tmp/claude-parent.jsonl', 100, 1000, 10, 20, NULL),
        ('claude-child', 'claude', 'fixture/proj', NULL, '2026-06-01T10:01:00Z',
         '2026-06-01T10:02:00Z', 'claude-parent', 'subagent', '/tmp/fixture/proj', 'main',
         'claude-child', '/tmp/claude-child.jsonl', 50, 1001, 11, 20, NULL),
        ('codex:codex-1', 'codex', 'fixture/codex', 'codex hello', '2026-06-02T10:00:00Z',
         '2026-06-02T10:05:00Z', NULL, '', '/tmp/fixture/codex', '', 'codex-1',
         '/tmp/codex.jsonl', 200, 2000, 12, 20, NULL),
        ('gemini:gemini-1', 'gemini', 'fixture/gemini', 'gemini hello', '2026-06-03T10:00:00Z',
         '2026-06-03T10:05:00Z', NULL, '', '/tmp/fixture/gemini', '', 'gemini-1',
         '/tmp/gemini.jsonl', 300, 3000, 13, 20, NULL);
      INSERT INTO messages VALUES
        (1, 'claude-parent', 0, 'assistant', '2026-06-01T10:00:01Z',
         'claude-sonnet-4-6',
         '{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":20,"cache_read_input_tokens":30}',
         'claude-message-1', 'request-1'),
        (2, 'codex:codex-1', 0, 'assistant', '2026-06-02T10:00:01Z',
         'gpt-5.5',
         '{"input_tokens":750,"output_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":250}',
         '', ''),
        (3, 'gemini:gemini-1', 0, 'assistant', '2026-06-03T10:00:01Z',
         'gemini-2.5-flash',
         '{"input_tokens":75,"output_tokens":15,"cache_creation_input_tokens":0,"cache_read_input_tokens":25}',
         '', '');
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_ordinal INTEGER,
        source TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        cost_status TEXT NOT NULL DEFAULT '',
        cost_source TEXT NOT NULL DEFAULT '',
        occurred_at TEXT,
        dedup_key TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO usage_events VALUES
        (1, 'codex:codex-1', 1, 'codex-token-count', 'gpt-5.5',
         30, 7, 0, 10, 3, NULL, '', '', '2026-06-02T10:00:02Z', 'event-1');
    `,
  );
  if (includeToolCalls) {
    await exec(
      db,
      `
        CREATE TABLE tool_calls (
          id INTEGER PRIMARY KEY,
          message_id INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          category TEXT,
          tool_use_id TEXT,
          input_json TEXT,
          skill_name TEXT,
          result_content_length INTEGER,
          result_content TEXT,
          subagent_session_id TEXT
        );
        INSERT INTO tool_calls VALUES
          (1, 1, 'claude-parent', 'Skill', 'skill', 'skill-1',
           '{"skill":"jj:jj","args":"commit"}', 'jj:jj', 0, NULL, NULL),
          (2, 1, 'claude-parent', 'mcp__fathom__search_meetings', 'mcp', 'mcp-1',
           '{}', NULL, 0, NULL, NULL),
          (3, 1, 'claude-parent', 'Read', 'file-io', 'read-1',
           '{"file_path":"/tmp/fixture/proj/a.ts"}', NULL, 40, 'file contents', NULL);
      `,
    );
  }
  await close(db);
  return path;
}

describe("AgentsView importer", () => {
  test("uses the AgentsView data-directory environment convention", () => {
    const previous = process.env.AGENTSVIEW_DATA_DIR;
    process.env.AGENTSVIEW_DATA_DIR = "/tmp/custom-agentsview";
    try {
      expect(agentsViewDatabasePath()).toBe("/tmp/custom-agentsview/sessions.db");
    } finally {
      if (previous === undefined) delete process.env.AGENTSVIEW_DATA_DIR;
      else process.env.AGENTSVIEW_DATA_DIR = previous;
    }
  });

  test("imports supported facts from a genuinely read-only database without modifying it", async () => {
    const path = await createFixture();
    chmodSync(path, 0o444);
    const before = hashFile(path);
    const importer = new AgentsViewImporter({ databasePath: path });
    const probe = await importer.probe();
    expect(probe.compatible).toBe(true);
    if (!probe.compatible) throw new Error(probe.reason);

    const fragments = await importer.importFragments(probe);
    expect(hashFile(path)).toBe(before);
    expect(fragments.map((fragment) => fragment.provenance.coverage[0]?.source).sort()).toEqual([
      "claude",
      "codex",
      "gemini",
    ]);

    const claude = fragments.find(
      (fragment) => fragment.provenance.coverage[0]?.source === "claude",
    )!;
    expect(claude.facts.messages[0]?.providerMessageId).toBe("claude-message-1");
    expect(claude.facts.messages[0]?.requestId).toBe("request-1");
    expect(claude.facts.messages[0]?.usage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 30,
      cacheWrite5m: 20,
      cacheWrite1h: 0,
    });
    expect(claude.facts.relationships[0]?.parentSourceSessionId).toBe("claude-parent");
    expect(claude.facts.invocations.find((fact) => fact.name === "Skill")?.skill).toBe(
      "jj:jj",
    );
    const mcp = claude.facts.invocations.find((fact) => fact.name.startsWith("mcp__"))!;
    expect(mcp.mcpServer).toBe("fathom");
    expect(mcp.mcpTool).toBe("search_meetings");
    expect(
      claude.facts.invocations.find((fact) => fact.name === "Read")?.filePath,
    ).toBe("/tmp/fixture/proj/a.ts");
    expect(claude.facts.toolResults[0]?.approxTokens).toBe(10);

    const codex = fragments.find(
      (fragment) => fragment.provenance.coverage[0]?.source === "codex",
    )!;
    expect(codex.facts.sessions[0]?.sourceSessionId).toBe("codex:codex-1");
    expect(codex.facts.messages[0]?.usage.input).toBe(750);
    expect(codex.facts.messages[0]?.usage.cacheRead).toBe(250);
    expect(codex.facts.messages[1]).toMatchObject({
      sourceSessionId: "codex:codex-1",
      model: "gpt-5.5",
      usage: {
        input: 30,
        output: 10,
        cacheRead: 10,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    });
    expect(codex.provenance.capabilities.usageEvents).toBe("complete");
    expect(codex.provenance.capabilities.codexTokenCountSemantics).toBe("partial");

    const gemini = fragments.find(
      (fragment) => fragment.provenance.coverage[0]?.source === "gemini",
    )!;
    expect(gemini.facts.sessions[0]?.sourceSessionId).toBe("gemini:gemini-1");
  });

  test("reports optional tool-call capability as missing instead of rejecting the database", async () => {
    const path = await createFixture(false);
    const importer = new AgentsViewImporter({ databasePath: path });
    const probe = await importer.probe();
    expect(probe.compatible).toBe(true);
    if (!probe.compatible) throw new Error(probe.reason);
    const fragments = await importer.importFragments(probe);
    expect(fragments[0]?.provenance.capabilities.toolCalls).toBe("missing");
    expect(fragments.every((fragment) => fragment.facts.invocations.length === 0)).toBe(true);
  });

  test("rejects a database that changes after probing", async () => {
    const path = await createFixture();
    const importer = new AgentsViewImporter({ databasePath: path });
    const probe = await importer.probe();
    expect(probe.compatible).toBe(true);
    if (!probe.compatible) throw new Error(probe.reason);

    const db = await openDatabase(path);
    await exec(
      db,
      "INSERT INTO sessions (id, agent) VALUES ('later-session', 'claude')",
    );
    await close(db);

    await expect(importer.importFragments(probe)).rejects.toThrow(
      "changed after compatibility probing",
    );
  });

  test("returns an incompatible probe when required columns are absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "argus-agentsview-bad-"));
    tempDirs.push(dir);
    const path = join(dir, "sessions.db");
    const db = await openDatabase(path);
    await exec(db, "CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE messages (id INTEGER)");
    await close(db);

    const probe = await new AgentsViewImporter({ databasePath: path }).probe();
    expect(probe.compatible).toBe(false);
    if (probe.compatible) throw new Error("expected incompatible probe");
    expect(probe.reason).toContain("missing required schema");
  });
});
