import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { aggregate } from "../src/aggregate.ts";
import { parseAll } from "../src/parse.ts";
import { emptyUsage, type MessageRecord, type ParseResult, type PluginInfo } from "../src/types.ts";

const FIX = join(import.meta.dir, "fixtures");
const parsed = parseAll({ projectsDir: join(FIX, "projects"), historyFile: join(FIX, "history.jsonl") });
const dash = aggregate(parsed, new Map<string, PluginInfo>(), new Map());

describe("aggregate", () => {
  test("totals reflect the deduped message set", () => {
    expect(dash.totals.messages).toBe(3);
    expect(dash.totals.sessions).toBe(1);
    // m1 total = 10+5+100+20+30 = 165 ; m2 = 2+8+0+40 = 50 ; m3 = 1+3 = 4
    expect(dash.totals.total).toBe(219);
    expect(dash.totals.cost).toBeGreaterThan(0);
  });

  test("attributes tokens by skill", () => {
    const jj = dash.bySkill.find((s) => s.name === "jj:jj")!;
    expect(jj.messages).toBe(1);
    expect(dash.bySkill.some((s) => s.name === "(none)")).toBe(true);
  });

  test("splits by model", () => {
    const names = dash.byModel.map((m) => m.name);
    expect(names).toContain("claude-sonnet-4-6");
    expect(names).toContain("claude-haiku-4-5-20251001");
  });

  test("splits by source", () => {
    const claude = dash.bySource.find((s) => s.name === "claude")!;
    expect(claude.messages).toBe(3);
    expect(claude.meta?.sessions).toBe(1);
    expect(dash.sessions.every((s) => s.source === "claude")).toBe(true);
  });

  test("counts MCP server calls and heaviest tool results", () => {
    const fathom = dash.byMcpServer.find((m) => m.server === "fathom")!;
    expect(fathom.calls).toBe(1);
    // MCP tool names are split server · tool (the raw mcp__ prefix is stripped).
    expect(fathom.topTools.map((t) => t.tool)).toContain("search_meetings");
    expect(dash.heaviestToolResults.some((t) => t.tool === "Edit")).toBe(true);
  });

  test("ranks tools and rolls them up by category (cc-lens style)", () => {
    const edit = dash.byTool.find((t) => t.name === "Edit")!;
    expect(edit.category).toBe("file-io");
    expect(edit.calls).toBeGreaterThan(0);
    expect(edit.sessions).toBe(1);

    const mcpTool = dash.byTool.find((t) => t.name === "mcp__fathom__search_meetings")!;
    expect(mcpTool.category).toBe("mcp");
    expect(mcpTool.display).toBe("fathom · search_meetings");

    const fileIo = dash.byToolCategory.find((c) => c.category === "file-io")!;
    expect(fileIo.label).toBe("File I/O");
    expect(fileIo.calls).toBeGreaterThan(0);
    expect(fileIo.tools).toBeGreaterThan(0);
    // total category calls equal total tool calls
    const catCalls = dash.byToolCategory.reduce((s, c) => s + c.calls, 0);
    const toolCalls = dash.byTool.reduce((s, t) => s + t.calls, 0);
    expect(catCalls).toBe(toolCalls);
  });

  test("groups by project", () => {
    expect(dash.byProject.map((p) => p.name)).toContain("fixture/proj");
  });

  test("prices tiered models per message rather than on combined usage", () => {
    const message = (sessionId: string): MessageRecord => ({
      source: "gemini",
      sessionId,
      project: "fixture/gemini",
      cwd: "/Users/fixture/gemini",
      gitBranch: "",
      ts: 1,
      date: "2026-06-01",
      model: "gemini-2.5-pro",
      usage: { ...emptyUsage(), input: 150_000 },
      attributionSkill: null,
      toolUses: [],
    });
    const tiered: ParseResult = {
      messages: [message("g1"), message("g2")],
      sessions: new Map(),
      toolResults: new Map(),
    };
    const result = aggregate(tiered, new Map(), new Map());
    expect(result.byModel[0]?.cost).toBeCloseTo(0.375, 6);
    expect(result.totals.cost).toBeCloseTo(0.375, 6);
  });
});
