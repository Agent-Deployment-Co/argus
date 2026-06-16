import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSession, cachedSessionAnalysis, condenseSessionTranscript } from "../src/session-analysis.ts";
import type { MessageRecord, SessionHealth, SessionMeta, SessionRow } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-session-analysis-"));
  tempDirs.push(dir);
  return dir;
}

function health(outcome: SessionHealth["outcome"] = "clean"): SessionHealth {
  return {
    interruptions: 0,
    rejections: 0,
    compactions: 0,
    turns: 1,
    medianTurnMs: 1000,
    maxTurnMs: 1000,
    stopReasons: { end_turn: 1 },
    tokenGrowth: null,
    outcome,
  };
}

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    source: "claude",
    sessionId: "sess-analysis",
    project: "adc/argus",
    start: 1780333200000,
    end: 1780333260000,
    durationMs: 60000,
    messages: 1,
    models: ["claude-sonnet-4-6"],
    topSkills: ["jj:jj"],
    toolCounts: {},
    filesTouched: ["/Users/fixture/proj/a.ts"],
    total: 123,
    cost: 0.0123,
    firstPrompt: "add a cached session analyzer",
    summary: "",
    health: health(),
    ...over,
  };
}

function message(over: Partial<MessageRecord> = {}): MessageRecord {
  return {
    source: "claude",
    sessionId: "sess-analysis",
    project: "adc/argus",
    cwd: "/Users/fixture/proj",
    gitBranch: "main",
    ts: 1780333260000,
    date: "2026-06-01",
    model: "claude-sonnet-4-6",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    attributionSkill: "jj:jj",
    stopReason: "end_turn",
    toolUses: [
      { name: "Skill", category: "skill", skill: "jj:jj", args: "status" },
      { name: "mcp__github__get_issue", category: "mcp", mcpServer: "github", mcpTool: "get_issue" },
      { name: "Edit", category: "file-io", filePath: "/Users/fixture/proj/a.ts" },
    ],
    ...over,
  };
}

function transcriptFile(dir: string): string {
  const filePath = join(dir, "sess-analysis.jsonl");
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "user",
        sessionId: "sess-analysis",
        message: { content: [{ type: "text", text: "add a cached session analyzer" }] },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-analysis",
        message: { content: [{ type: "text", text: "Done. Tests passed." }] },
      }),
    ].join("\n"),
  );
  return filePath;
}

describe("session analysis", () => {
  test("creates a cached heuristic analysis with tool, skill, and MCP breakdowns", async () => {
    const dir = tempDir();
    const filePath = transcriptFile(dir);
    const storePath = join(dir, "argus.db");
    const meta: SessionMeta = {
      source: "claude",
      sessionId: "sess-analysis",
      project: "adc/argus",
      cwd: "/Users/fixture/proj",
      filePath,
      firstPrompt: "add a cached session analyzer",
    };

    const first = await analyzeSession({
      row: row(),
      meta,
      messages: [message()],
      useLlm: false,
      storePath,
    });
    expect(first.fromCache).toBe(false);
    expect(first.analysis.generatedBy).toBe("heuristic");
    expect(first.analysis.sessionLogPath).toBe(filePath);
    expect(first.analysis.outcome).toBe("success");
    expect(first.analysis.tools.map((tool) => tool.name).sort()).toEqual([
      "Edit",
      "Skill",
      "mcp__github__get_issue",
    ]);
    expect(first.analysis.skills).toEqual([{ name: "jj:jj", calls: 1, messages: 1 }]);
    expect(first.analysis.mcpServers).toEqual([
      { server: "github", calls: 1, topTools: [{ tool: "get_issue", count: 1 }] },
    ]);

    const second = await analyzeSession({
      row: row(),
      meta,
      messages: [message()],
      useLlm: false,
      storePath,
    });
    expect(second.fromCache).toBe(true);
    expect(second.analysis).toEqual(first.analysis);
    expect((await cachedSessionAnalysis({ row: row(), messages: [message()], storePath }))?.title).toBe(first.analysis.title);
    expect(
      await cachedSessionAnalysis({
        row: row({ end: 1780333320000 }),
        messages: [message({ ts: 1780333320000 })],
        storePath,
      }),
    ).toBeUndefined();
    expect(
      await cachedSessionAnalysis({
        row: row({ firstPrompt: "fix the session title bug" }),
        messages: [message()],
        storePath,
      }),
    ).toBeUndefined();
  });

  test("condenses Codex transcript messages, tools, and results", () => {
    const dir = tempDir();
    const filePath = join(dir, "codex.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run checks" }] } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{\"cmd\":\"bun test\"}" } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "tests passed" } }),
      ].join("\n"),
    );

    const condensed = condenseSessionTranscript(filePath);
    expect(condensed.body).toContain("USER: run checks");
    expect(condensed.body).toContain("TOOLS: exec_command");
    expect(condensed.body).toContain("TOOL RESULT: tests passed");
    expect(condensed.finalToolResultText).toBe("tests passed");
  });
});
