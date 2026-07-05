// Unit tests for the per-view builders (#217) — the folding/pricing/sorting logic that moved out of
// the deleted monolithic aggregate() into src/api/{usage,tools,plugins}.ts. Pure functions fed
// synthetic store rows (the same shape the store's per-view read methods return), plus buildSessionRow
// (still shared by the session-detail path) and the narrowed recommendation rules.
import { describe, expect, test } from "bun:test";
import { buildUsageByModel, buildUsageByProject, buildUsageBySource, buildUsageDaily } from "../src/api/usage.ts";
import {
  buildByMcpServer,
  buildByTool,
  buildByToolCategory,
  buildHeaviestResults,
  buildSkills,
  foldBySkill,
} from "../src/api/tools.ts";
import { buildPlugins } from "../src/api/plugins.ts";
import { computeRecommendations } from "../src/api/recommendations.ts";
import { buildSessionRow } from "../src/reporting/aggregate.ts";
import { emptyUsage, type MessageRecord, type PluginInfo, type SessionMeta, type Usage } from "../src/types.ts";

const u = (input: number, extra: Partial<Usage> = {}): Usage => ({ ...emptyUsage(), input, ...extra });

describe("usage builders", () => {
  const byDateModel = [
    { date: "2026-06-02", model: "opus", usage: u(1000), messages: 1 },
    { date: "2026-06-01", model: "haiku", usage: u(1000, { output: 500 }), messages: 2 },
  ];

  test("buildUsageDaily rolls up totals, sorts days, and passes the session count through", () => {
    const res = buildUsageDaily(byDateModel, 5);
    expect(res.totals.sessions).toBe(5);
    expect(res.totals.messages).toBe(3);
    expect(res.totals.total).toBe(2500); // (1000+500) + 1000
    expect(res.totals.cost).toBeGreaterThan(0);
    expect(res.daily.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02"]); // ascending
    expect(res.daily[0]!.output).toBe(500);
    expect(Array.isArray(res.unpriced)).toBe(true);
  });

  test("buildUsageDaily surfaces models it can't price", () => {
    const res = buildUsageDaily([{ date: "2026-06-01", model: "mystery-model-xyz", usage: u(10), messages: 1 }], 1);
    expect(res.unpriced).toContain("mystery-model-xyz");
  });

  test("buildUsageByModel prices each model on its own and builds the per-day series", () => {
    const res = buildUsageByModel(byDateModel);
    // Sorted by total tokens desc: haiku row is 1000 input + 500 output = 1500, opus is 1000.
    expect(res.byModel.map((m) => m.name)).toEqual(["haiku", "opus"]);
    const haiku = res.byModel.find((m) => m.name === "haiku")!;
    expect(haiku.cost).toBeCloseTo((1000 * 1 + 500 * 5) / 1e6, 9); // haiku input 1, output 5 per Mtok
    expect(res.byModelDaily.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-02"]);
    expect(res.byModelDaily[1]!.byModel.opus).toBe(1000);
  });

  test("buildUsageBySource prices a mixed-model source per model and carries session counts", () => {
    const rows = [
      { source: "claude", model: "opus", usage: u(1000), messages: 1 },
      { source: "claude", model: "haiku", usage: u(1000), messages: 1 },
    ];
    const { bySource } = buildUsageBySource(rows, [{ source: "claude", sessions: 3 }]);
    const claude = bySource.find((s) => s.name === "claude")!;
    // opus input 15/Mtok + haiku input 1/Mtok, priced separately then summed.
    expect(claude.cost).toBeCloseTo((1000 * 15 + 1000 * 1) / 1e6, 9);
    expect(claude.meta?.sessions).toBe(3);
  });

  test("buildUsageByProject carries per-project session counts", () => {
    const rows = [{ project: "web", model: "haiku", usage: u(500), messages: 1 }];
    const { byProject } = buildUsageByProject(rows, [{ project: "web", sessions: 2 }]);
    expect(byProject[0]!.name).toBe("web");
    expect(byProject[0]!.meta?.sessions).toBe(2);
  });
});

describe("tools builders", () => {
  test("buildSkills folds skills (with (none)) and builds the per-day series", () => {
    const rows = [
      { skill: "jj:jj", model: "haiku", usage: u(10), messages: 1 },
      { skill: "", model: "haiku", usage: u(5), messages: 1 },
    ];
    const { bySkill, bySkillDaily } = buildSkills(
      rows,
      [{ date: "2026-06-01", skill: "jj:jj", total: 10 }],
      new Map<string, PluginInfo>(),
    );
    expect(bySkill.some((s) => s.name === "jj:jj")).toBe(true);
    expect(bySkill.some((s) => s.name === "(none)")).toBe(true);
    expect(bySkillDaily[0]!.bySkill["jj:jj"]).toBe(10);
  });

  const toolStats = [
    { tool: "Edit", category: "file-io" as const, calls: 3, sessions: 1 },
    { tool: "mcp__fathom__search_meetings", category: "mcp" as const, calls: 1, sessions: 1 },
  ];
  const toolResultStats = [{ tool: "Edit", count: 2, approxTokens: 100 }];

  test("buildByTool ranks by calls, names MCP tools, and joins result tokens", () => {
    const { byTool } = buildByTool(toolStats, toolResultStats);
    expect(byTool[0]!.name).toBe("Edit"); // most calls first
    expect(byTool.find((t) => t.name === "Edit")!.approxResultTokens).toBe(100);
    expect(byTool.find((t) => t.name === "mcp__fathom__search_meetings")!.display).toBe("fathom · search_meetings");
  });

  test("buildByToolCategory labels categories and sums result tokens over their tools", () => {
    const categoryStats = [
      { category: "file-io" as const, calls: 3, tools: 1, sessions: 1 },
      { category: "mcp" as const, calls: 1, tools: 1, sessions: 1 },
    ];
    const { byToolCategory } = buildByToolCategory(categoryStats, toolStats, toolResultStats);
    const fileIo = byToolCategory.find((c) => c.category === "file-io")!;
    expect(fileIo.label).toBe("File I/O");
    expect(fileIo.approxResultTokens).toBe(100);
    expect(byToolCategory.reduce((s, c) => s + c.calls, 0)).toBe(4);
  });

  test("buildByMcpServer splits mcp__server__tool names for topTools", () => {
    const { byMcpServer } = buildByMcpServer(
      [{ server: "fathom", calls: 1 }],
      [{ server: "fathom", tool: "mcp__fathom__search_meetings", count: 1 }],
      [{ tool: "mcp__fathom__search_meetings", count: 1, approxTokens: 50 }],
    );
    expect(byMcpServer[0]!.topTools.map((t) => t.tool)).toContain("search_meetings");
    expect(byMcpServer[0]!.approxResultTokens).toBe(50);
  });

  test("buildHeaviestResults sorts by approx tokens desc", () => {
    const { heaviestToolResults } = buildHeaviestResults([
      { tool: "Read", count: 1, approxTokens: 10 },
      { tool: "Edit", count: 2, approxTokens: 100 },
    ]);
    expect(heaviestToolResults[0]!.tool).toBe("Edit");
  });
});

describe("plugins builder", () => {
  test("folds skill usage into plugins and seeds enabled-but-unused ones", () => {
    const plugins = new Map<string, PluginInfo>([
      ["used-plugin", { name: "used-plugin", marketplace: "m", enabled: true }],
      ["idle-plugin", { name: "idle-plugin", marketplace: "m", enabled: true }],
    ]);
    const bySkill = foldBySkill([{ skill: "used-plugin:do", model: "haiku", usage: u(10), messages: 1 }], plugins);
    const { byPlugin } = buildPlugins(bySkill, [], plugins);
    expect(byPlugin.find((p) => p.name === "used-plugin")!.used).toBe(true);
    const idle = byPlugin.find((p) => p.name === "idle-plugin")!;
    expect(idle.enabled).toBe(true);
    expect(idle.used).toBe(false);
  });
});

describe("recommendations (narrowed inputs)", () => {
  test("fires each designed-for rule from its own input", () => {
    const recs = computeRecommendations({
      byPlugin: [
        { name: "idle", marketplace: "m", enabled: true, used: false, skills: [], skillMessages: 0, skillTokens: 0, skillCost: 0, mcpCalls: 0 },
      ],
      highTokenGrowthSessions: 3,
      frictionTotals: { observableSessions: 10, interruptions: 20, rejections: 6, compactions: 6, turns: 100 },
      unpriced: ["mystery"],
    });
    expect(recs.map((r) => r.id).sort()).toEqual(
      ["frequent-compactions", "high-interruptions", "rejections", "token-growth", "unpriced-models", "unused-plugins"].sort(),
    );
  });
});

describe("buildSessionRow", () => {
  const message = (over: Partial<MessageRecord> = {}): MessageRecord => ({
    source: "codex",
    sessionId: "s1",
    project: "fixture/codex",
    cwd: "/Users/fixture/codex",
    gitBranch: "",
    ts: 1,
    date: "2026-06-01",
    model: "gpt-5",
    usage: u(10),
    attributionSkill: null,
    toolUses: [],
    ...over,
  });

  test("attaches the session's generated tasks", () => {
    const task = {
      id: "task:s1",
      source: "codex" as const,
      sourceSessionId: "s1",
      timestampMs: 1,
      description: "Ship the panel",
      evidence: "message indexes: 0",
      evidenceKind: "llm_inference" as const,
      position: { originKey: "fixture", recordIndex: 0, itemIndex: 0 },
    };
    const row = buildSessionRow("s1", [message()], undefined, "", [task]);
    expect(row.tasks).toEqual([task]);
  });

  test("carries source-owned user/agent/turn counts and folds them into health.turns", () => {
    const meta: SessionMeta = {
      source: "codex",
      sessionId: "s1",
      project: "fixture/codex",
      cwd: "/Users/fixture/codex",
      filePath: "/tmp/codex.jsonl",
      userMessages: 8,
      agentMessages: 287,
      rawTurns: 8,
    };
    const row = buildSessionRow("s1", [message()], meta, "", []);
    expect(row).toMatchObject({
      messages: 1,
      userMessages: 8,
      agentMessages: 287,
      rawTurns: 8,
      health: expect.objectContaining({ turns: 8 }),
    });
  });
});
