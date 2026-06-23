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
import { openStore } from "../src/store/store.ts";
import { syncStatsSummary, parseAllIncrementalDetailed, readStore } from "../src/indexing/pipeline.ts";
import type { SyncStats } from "../src/indexing/pipeline.ts";
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

function storePath(root: string): string {
  return join(root, "cache", "fragments.sqlite3");
}

function stats(overrides: Partial<SyncStats> = {}): SyncStats {
  return {
    hits: 0,
    parsed: 0,
    replaced: 0,
    deleted: 0,
    archived: 0,
    unstable: 0,
    failed: 0,
    incompleteDiscoveries: 0,
    fallback: false,
    ...overrides,
  };
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
  test("describes sync modes in plain language from stats", () => {
    expect(syncStatsSummary(stats({ hits: 2 }))).toStartWith("Read transcripts —");
    expect(syncStatsSummary(stats({ parsed: 3 }))).toStartWith("Read transcripts —");
    // Archived sessions are working as intended, so the per-pass summary stays quiet about them
    // (the count lives in `argus status`).
    expect(syncStatsSummary(stats({ parsed: 2, archived: 3 }))).not.toContain("kept after leaving disk");
    expect(syncStatsSummary(stats({ fallback: true }))).toBe(
      "Read transcripts directly (couldn't open the local store)",
    );
  });

  test("indexes all sources and reuses unchanged fragments on a second run", async () => {
    const root = tempRoot();
    const opts = {
      projectsDir: copyFixture("projects", root),
      historyFile: join(copyFixture("history.jsonl", root)),
      codexSessionsDir: copyFixture("codex-sessions", root),
      geminiDir: copyFixture("gemini", root),
      sources: ["claude", "codex", "gemini"] as AgentSource[],
      storePath: storePath(root),
    };

    const first = await parseAllIncrementalDetailed(opts);
    expect(first.parsed.sessions.size).toBeGreaterThan(0);
    expect(first.parsed.messages.length).toBeGreaterThan(0);
    expect(first.stats).toMatchObject({ hits: 0, parsed: 10, replaced: 10, fallback: false });

    // A second run reuses every unchanged fragment and yields an identical result.
    const second = await parseAllIncrementalDetailed(opts);
    expect(comparable(second.parsed)).toEqual(comparable(first.parsed));
    expect(second.stats).toMatchObject({ hits: 10, parsed: 0, replaced: 0, fallback: false });
  });

  test("reparses a changed transcript without rebuilding unchanged sources", async () => {
    const root = tempRoot();
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const opts = {
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      storePath: storePath(root),
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

  test("readStore reads the materialized store without reconciling (read-only legs of `run`)", async () => {
    const root = tempRoot();
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const opts = {
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      storePath: storePath(root),
    };

    // The index leg materializes the store.
    const indexed = await parseAllIncrementalDetailed(opts);
    expect(indexed.parsed.sessions.size).toBeGreaterThan(0);

    // Remove the transcripts from disk: a pure read must return the stored rows straight from the
    // read model, without touching disk, re-parsing, or writing (no fallback to a direct parse that
    // would omit retained sessions).
    rmSync(codexSessionsDir, { recursive: true, force: true });

    const readOnly = await readStore(opts);
    expect(readOnly.parsed.sessions.size).toBe(indexed.parsed.sessions.size);
    expect(readOnly.stats).toMatchObject({ parsed: 0, replaced: 0, hits: 0, deleted: 0, archived: 0, fallback: false });
  });

  test("a deleted transcript is tombstoned in the index but its session is retained (archived)", async () => {
    const root = tempRoot();
    const projectsDir = copyFixture("projects", root);
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const opts = {
      projectsDir,
      codexSessionsDir,
      historyFile: join(copyFixture("history.jsonl", root)),
      sources: ["claude", "codex"] as AgentSource[],
      storePath: storePath(root),
    };

    const before = await parseAllIncrementalDetailed(opts);
    const codexBefore = before.parsed.messages.filter((m) => m.source === "codex");
    const codexSessionIds = new Set(codexBefore.map((m) => m.sessionId));
    expect(codexBefore.length).toBeGreaterThan(0);
    rmSync(join(codexSessionsDir, "2026/06/03/rollout-2026-06-03T08-00-00-codex-sess1.jsonl"));

    const codexOnly = await parseAllIncrementalDetailed({
      ...opts,
      sources: ["codex"],
    });

    // Durable archive: the session's content is RETAINED even though its transcript is gone from disk.
    expect(codexOnly.parsed.messages).toEqual(codexBefore);
    expect(codexOnly.stats.deleted).toBe(1); // index fragment tombstoned (the index mirrors disk)
    expect(codexOnly.stats.archived).toBe(codexSessionIds.size); // session retained + flagged archived

    const cache = await openStore({ path: opts.storePath });
    try {
      // The structural index reflects disk (codex fragment gone); claude index untouched.
      expect((await cache.list("claude")).filter((row) => row.status === "success").length).toBeGreaterThan(0);
      expect((await cache.list("codex")).filter((row) => row.status === "success")).toEqual([]);
      // The resolved session survives, flagged archived.
      expect(new Set(await cache.listArchived("codex"))).toEqual(codexSessionIds);
    } finally {
      await cache.close();
    }
  });

  test("forget permanently removes a retained (archived) session", async () => {
    const root = tempRoot();
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const opts = {
      codexSessionsDir,
      sources: ["codex"] as AgentSource[],
      storePath: storePath(root),
    };

    await parseAllIncrementalDetailed(opts);
    rmSync(join(codexSessionsDir, "2026/06/03/rollout-2026-06-03T08-00-00-codex-sess1.jsonl"));
    await parseAllIncrementalDetailed(opts); // archives the now-off-disk session

    const cache = await openStore({ path: opts.storePath });
    try {
      const archived = await cache.listArchived();
      expect(archived.length).toBeGreaterThan(0);
      await cache.retractSessions(archived);
      expect(await cache.listArchived()).toEqual([]);
      expect((await cache.readResolved()).messages).toEqual([]);
    } finally {
      await cache.close();
    }
  });

  test("a read degrades to a temp store when the real store cannot be opened", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const path = storePath(root);
    writeFileSync(path, "not sqlite");

    const parsed = await readStore({
      codexSessionsDir: copyFixture("codex-sessions", root),
      sources: ["codex"] as AgentSource[],
      storePath: path,
    });

    expect(parsed.stats.fallback).toBe(true);
    expect(parsed.diagnostics[0]?.code).toBe("store_fallback");
    expect(parsed.parsed.messages).toHaveLength(2);
  });

  test("an index fails loud when the real store cannot be opened (no silent temp write)", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "cache"), { recursive: true });
    const path = storePath(root);
    writeFileSync(path, "not sqlite");

    await expect(
      parseAllIncrementalDetailed({
        codexSessionsDir: copyFixture("codex-sessions", root),
        sources: ["codex"] as AgentSource[],
        storePath: path,
      }),
    ).rejects.toThrow();
  });

});

describe("materialized read model", () => {
  const claudeOpts = (root: string) => ({
    projectsDir: copyFixture("projects", root),
    historyFile: join(copyFixture("history.jsonl", root)),
    sources: ["claude"] as AgentSource[],
    storePath: storePath(root),
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
      storePath: storePath(root),
    };
    const first = (await parseAllIncrementalDetailed(opts)).parsed;
    const second = await parseAllIncrementalDetailed(opts);
    expect(comparable(second.parsed)).toEqual(comparable(first));
    expect(second.stats.parsed).toBe(0); // every fragment was a cache hit
  });

  test("deleting a transcript retains its session — the store is a superset of a fresh rebuild", async () => {
    const root = tempRoot();
    const codexSessionsDir = copyFixture("codex-sessions", root);
    const base = { codexSessionsDir, sources: ["codex"] as AgentSource[] };

    const incrementalPath = storePath(root);
    const original = (await parseAllIncrementalDetailed({ ...base, storePath: incrementalPath })).parsed;
    rmSync(join(codexSessionsDir, "2026/06/03/rollout-2026-06-03T08-00-00-codex-sess1.jsonl"));
    const incremental = (await parseAllIncrementalDetailed({ ...base, storePath: incrementalPath })).parsed;

    // A fresh store sees only what's on disk now (the deleted transcript is gone).
    const rebuilt = (
      await parseAllIncrementalDetailed({ ...base, storePath: join(root, "cache", "fresh.sqlite3") })
    ).parsed;

    // Durable archive: the incremental store still holds the deleted session in full…
    expect(comparable(incremental)).toEqual(comparable(original));
    // …while the fresh rebuild, derived only from disk, has dropped it.
    expect(rebuilt.messages.length).toBeLessThan(incremental.messages.length);
    const rebuiltIds = new Set(rebuilt.messages.map((m) => m.sessionId));
    const incrementalIds = new Set(incremental.messages.map((m) => m.sessionId));
    for (const id of rebuiltIds) expect(incrementalIds.has(id)).toBe(true);
  });
});
