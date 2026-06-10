import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAll, projectLabel } from "../src/parse.ts";

const FIX = join(import.meta.dir, "fixtures");
const opts = { projectsDir: join(FIX, "projects"), historyFile: join(FIX, "history.jsonl") };

describe("parseAll", () => {
  const parsed = parseAll(opts);

  test("dedupes replayed message ids and includes subagent transcripts", () => {
    // m1 (one message streamed across 2 lines) + m2 + m3 (from subagents/) = 3
    expect(parsed.messages.length).toBe(3);
    expect(parsed.messages.every((m) => m.source === "claude")).toBe(true);
  });

  test("merges tool_uses from every line of a streamed message; counts usage once", () => {
    // Claude streams one assistant message (m1) across two lines with repeated usage:
    //   line 1 → Edit + Skill ; line 2 (continuation) → text + mcp__fathom__search_meetings.
    // All three tool calls must survive (no dropping the continuation line), but the repeated
    // usage must be counted exactly once.
    const m1s = parsed.messages.filter((m) => m.usage.input === 10);
    expect(m1s.length).toBe(1); // usage counted once, not per line
    const names = m1s[0]!.toolUses.map((t) => t.name).sort();
    expect(names).toEqual(["Edit", "Skill", "mcp__fathom__search_meetings"]);
  });

  test("normalizes the 5m/1h cache-creation split", () => {
    const m1 = parsed.messages.find((m) => m.usage.input === 10)!;
    expect(m1.usage.cacheWrite5m).toBe(20);
    expect(m1.usage.cacheWrite1h).toBe(30);
    expect(m1.usage.cacheRead).toBe(100);
    expect(m1.usage.output).toBe(5);
    expect(m1.attributionSkill).toBe("jj:jj");
    expect(m1.model).toBe("claude-sonnet-4-6");
  });

  test("falls back to legacy cache_creation_input_tokens as 5m", () => {
    const m2 = parsed.messages.find((m) => m.model.includes("haiku"))!;
    expect(m2.usage.cacheWrite5m).toBe(40);
    expect(m2.usage.cacheWrite1h).toBe(0);
  });

  test("extracts Skill, MCP server, and file-path tool uses", () => {
    const m1 = parsed.messages.find((m) => m.usage.input === 10)!;
    const names = m1.toolUses.map((t) => t.name);
    expect(names).toContain("Edit");
    expect(names).toContain("mcp__fathom__search_meetings");
    expect(names).toContain("Skill");
    const mcp = m1.toolUses.find((t) => t.name.startsWith("mcp__"))!;
    expect(mcp.mcpServer).toBe("fathom");
    expect(mcp.mcpTool).toBe("search_meetings");
    expect(mcp.category).toBe("mcp");
    const skill = m1.toolUses.find((t) => t.name === "Skill")!;
    expect(skill.skill).toBe("jj:jj");
    expect(skill.args).toContain("commit");
    expect(skill.category).toBe("skill");
    const edit = m1.toolUses.find((t) => t.name === "Edit")!;
    expect(edit.filePath).toBe("/Users/fixture/proj/a.ts");
    expect(edit.category).toBe("file-io");
  });

  test("emits source-neutral capability events without assuming outcomes", () => {
    expect(parsed.capabilityEvents).toHaveLength(3);
    expect(parsed.capabilityEvents.map((event) => event.capability.type).sort()).toEqual([
      "mcp",
      "skill",
      "tool",
    ]);
    expect(parsed.capabilityEvents.every((event) => event.outcome === "unknown")).toBe(true);
    expect(parsed.capabilityEvents.every((event) => event.assessmentBasis === "unassessed")).toBe(true);
    expect(parsed.capabilityEvents.every((event) => event.confidence === 0)).toBe(true);

    const skill = parsed.capabilityEvents.find((event) => event.capability.type === "skill")!;
    expect(skill.capability.name).toBe("jj:jj");
    expect(skill.invocationId).toBe("t3");

    const mcp = parsed.capabilityEvents.find((event) => event.capability.type === "mcp")!;
    expect(mcp.capability.mcpServer).toBe("fathom");
    expect(mcp.capability.mcpTool).toBe("search_meetings");
    expect(mcp.timestamp).toBe(Date.parse("2026-06-01T17:00:01.500Z"));
  });

  test("attributes tool-result token weight to the producing tool", () => {
    const edit = parsed.toolResults.get("Edit");
    expect(edit?.count).toBe(1);
    expect(edit?.approxTokens).toBeGreaterThan(0);
  });

  test("records session metadata, project label, and first prompt from history", () => {
    const meta = parsed.sessions.get("sess1")!;
    expect(meta.project).toBe("fixture/proj");
    expect(meta.firstPrompt).toBe("hello there"); // earliest by timestamp, not "a later prompt"
  });

  test("messages carry a YYYY-MM-DD local date", () => {
    for (const m of parsed.messages) expect(m.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("parseAll with Codex transcripts", () => {
  const parsed = parseAll({ codexSessionsDir: join(FIX, "codex-sessions"), sources: ["codex"] });

  test("turns Codex token_count events into message records", () => {
    expect(parsed.messages.length).toBe(2);
    expect(parsed.sessions.size).toBe(1);
    expect(parsed.messages[0]?.sessionId).toBe("codex:codex-sess1");
    expect(parsed.messages[0]?.source).toBe("codex");
    expect(parsed.messages[0]?.model).toBe("gpt-5.5");
    expect(parsed.messages[1]?.model).toBe("gpt-5.4-mini");
  });

  test("splits OpenAI cached input out of total input", () => {
    const first = parsed.messages[0]!;
    expect(first.usage.input).toBe(750);
    expect(first.usage.cacheRead).toBe(250);
    expect(first.usage.output).toBe(40);
    expect(first.usage.cacheWrite5m).toBe(0);
    expect(first.usage.cacheWrite1h).toBe(0);
  });

  test("keeps total-only Codex token counters visible", () => {
    const second = parsed.messages[1]!;
    expect(second.usage.input).toBe(99);
    expect(second.usage.cacheRead).toBe(0);
    expect(second.usage.output).toBe(0);
  });

  test("extracts Codex tool calls and result-token weight", () => {
    expect(parsed.messages[0]?.toolUses.map((t) => t.name)).toContain("exec_command");
    expect(parsed.messages[1]?.toolUses.map((t) => t.name)).toContain("web_search_call");
    const stat = parsed.toolResults.get("exec_command");
    expect(stat?.count).toBe(1);
    expect(stat?.approxTokens).toBeGreaterThan(0);
  });

  test("preserves Codex invocation IDs and timestamps in capability events", () => {
    expect(parsed.capabilityEvents).toHaveLength(2);
    const exec = parsed.capabilityEvents.find((event) => event.capability.name === "exec_command")!;
    expect(exec.source).toBe("codex");
    expect(exec.invocationId).toBe("call-1");
    expect(exec.timestamp).toBe(Date.parse("2026-06-03T13:00:03.000Z"));
    expect(exec.outcome).toBe("unknown");
  });

  test("records Codex session metadata and first prompt", () => {
    const meta = parsed.sessions.get("codex:codex-sess1")!;
    expect(meta.project).toBe("fixture/codex-proj");
    expect(meta.source).toBe("codex");
    expect(meta.cwd).toBe("/Users/fixture/codex-proj");
    expect(meta.firstPrompt).toBe("codex hello");
  });
});

describe("parseAll with Gemini transcripts", () => {
  const parsed = parseAll({ geminiDir: join(FIX, "gemini"), sources: ["gemini"] });

  test("replays current JSONL and legacy JSON sessions", () => {
    expect(parsed.messages.length).toBe(4);
    expect(parsed.sessions.size).toBe(3);
    expect(parsed.messages.every((m) => m.source === "gemini")).toBe(true);
    expect(parsed.messages.map((m) => m.sessionId)).toContain("gemini:gemini-subagent");
    expect(parsed.messages.map((m) => m.sessionId)).toContain("gemini:gemini-legacy");
  });

  test("keeps the final message update and applies rewinds", () => {
    const main = parsed.messages.filter((m) => m.sessionId === "gemini:gemini-main");
    expect(main.length).toBe(2);
    expect(main.some((m) => m.usage.input === 999)).toBe(false);
    expect(main.some((m) => m.usage.input === 5000)).toBe(false);
    expect(main[0]?.toolUses.map((t) => t.name)).toContain("read_file");
  });

  test("splits cached input and includes thought/tool tokens in output", () => {
    const first = parsed.messages.find((m) => m.model === "gemini-2.5-flash")!;
    expect(first.usage.input).toBe(75);
    expect(first.usage.cacheRead).toBe(25);
    expect(first.usage.output).toBe(15);
    expect(first.usage.cacheWrite5m).toBe(0);
    expect(first.usage.cacheWrite1h).toBe(0);
  });

  test("extracts Gemini tools, paths, result weight, and categories", () => {
    const first = parsed.messages.find((m) => m.model === "gemini-2.5-flash")!;
    const read = first.toolUses.find((t) => t.name === "read_file")!;
    expect(read.filePath).toBe("/Users/fixture/gemini-proj/a.ts");
    expect(read.category).toBe("file-io");
    expect(parsed.toolResults.get("read_file")?.count).toBe(1);
    expect(parsed.toolResults.get("read_file")?.approxTokens).toBeGreaterThan(0);
  });

  test("preserves Gemini invocation IDs in capability events", () => {
    expect(parsed.capabilityEvents).toHaveLength(4);
    const read = parsed.capabilityEvents.find((event) => event.capability.name === "read_file")!;
    expect(read.source).toBe("gemini");
    expect(read.invocationId).toBe("call-1");
    expect(read.capability.type).toBe("tool");
    expect(read.outcome).toBe("unknown");
  });

  test("resolves project roots and first prompts", () => {
    const main = parsed.sessions.get("gemini:gemini-main")!;
    expect(main.cwd).toBe("/Users/fixture/gemini-proj");
    expect(main.project).toBe("fixture/gemini-proj");
    expect(main.firstPrompt).toBe("gemini hello");

    const legacy = parsed.sessions.get("gemini:gemini-legacy")!;
    expect(legacy.cwd).toBe("/Users/fixture/gemini-legacy");
    expect(legacy.project).toBe("fixture/gemini-legacy");
  });
});

describe("projectLabel", () => {
  test("uses the last two path segments", () => {
    expect(projectLabel("/Users/mando/code/gw/webapp")).toBe("gw/webapp");
    expect(projectLabel("")).toBe("(unknown)");
  });
});
