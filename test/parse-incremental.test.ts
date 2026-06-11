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
import { openFragmentCache } from "../src/cache-store.ts";
import { parseAll } from "../src/parse.ts";
import { parseAllIncrementalDetailed } from "../src/parse-incremental.ts";
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
  test("matches the native parser and reuses unchanged fragments on a second run", async () => {
    const root = tempRoot();
    const opts = {
      projectsDir: copyFixture("projects", root),
      historyFile: join(copyFixture("history.jsonl", root)),
      codexSessionsDir: copyFixture("codex-sessions", root),
      geminiDir: copyFixture("gemini", root),
      sources: ["claude", "codex", "gemini"] as AgentSource[],
      cachePath: cachePath(root),
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
    };

    await parseAllIncrementalDetailed(opts);
    rmSync(join(codexSessionsDir, "2026/06/03/rollout-2026-06-03T08-00-00-codex-sess1.jsonl"));

    const codexOnly = await parseAllIncrementalDetailed({
      ...opts,
      sources: ["codex"],
    });
    expect(codexOnly.parsed.messages).toEqual([]);
    expect(codexOnly.stats.deleted).toBe(1);

    const cache = await openFragmentCache({ path: opts.cachePath });
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
    });

    expect(parsed.stats.fallback).toBe(true);
    expect(parsed.diagnostics[0]?.code).toBe("cache_fallback");
    expect(parsed.parsed.messages).toHaveLength(2);
  });
});
