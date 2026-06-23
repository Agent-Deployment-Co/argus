// #121 parity, richer cases: seed a store directly via materializeSessions with crafted data the small
// fixtures don't exercise — multiple sessions/projects/models/dates, a 12-turn session with growing
// token use (token-growth recommendation input), friction in metadata, an interrupted vs a clean
// outcome, MCP + Skill calls, and per-call result tokens. Then assert the JS walk over readResolved
// equals the SQL snapshot over readDashboardAggregates on the SAME store (true apples-to-apples).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../src/reporting/aggregate.ts";
import { assembleDashboard } from "../src/reporting/snapshot.ts";
import { openStore } from "../src/store/store.ts";
import type { MaterializeSession } from "../src/store/store-contract.ts";
import {
  emptyUsage,
  type MessageRecord,
  type PluginInfo,
  type SessionFriction,
  type ToolUse,
  type Usage,
} from "../src/types.ts";

const PLUGINS = new Map<string, PluginInfo>();

function usage(input: number, output: number, cacheRead = 0): Usage {
  return { ...emptyUsage(), input, output, cacheRead };
}

function msg(
  sessionId: string,
  project: string,
  cwd: string,
  ts: number,
  date: string,
  model: string,
  u: Usage,
  attributionSkill: string | null,
  toolUses: ToolUse[],
  stopReason?: string,
): MessageRecord {
  return {
    source: "claude",
    sessionId,
    project,
    cwd,
    gitBranch: "",
    ts,
    date,
    model,
    usage: u,
    attributionSkill,
    ...(stopReason ? { stopReason } : {}),
    toolUses,
  };
}

async function seededStore(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "argus-parity-syn-"));
  const path = join(dir, "argus.db");
  const store = await openStore({ path });

  // Session A: 12 turns, tokens grow ~10x start-to-finish (token-growth >= 5), friction present and a
  // trailing interruption (-> interrupted outcome). Mixed tools incl. MCP + Skill + result tokens.
  const aMessages: MessageRecord[] = [];
  for (let i = 0; i < 12; i++) {
    const grow = i < 6 ? 100 : 2000; // first decile small, last decile big
    const tools: ToolUse[] =
      i === 0
        ? [
            { name: "Bash", category: "shell", approxResultTokens: 50 },
            { name: "mcp__fathom__search", category: "mcp", mcpServer: "fathom", mcpTool: "search", approxResultTokens: 7 },
          ]
        : i === 1
          ? [{ name: "Skill", category: "skill", skill: "jj:jj", args: "do the thing" }]
          : [{ name: "Read", category: "file-io", filePath: "/repo/alpha/x.ts", approxResultTokens: 5 }];
    aMessages.push(
      msg("claude:A", "alpha", "/repo/alpha", 1000 + i, "2026-06-01", "claude-sonnet-4-6", usage(grow, grow / 2, grow * 3), i === 1 ? "jj:jj" : null, tools, "tool_use"),
    );
  }
  const aFriction: SessionFriction = {
    interruptions: 2,
    rejections: 1,
    compactions: 1,
    turns: 6,
    turnDurationsMs: [100, 200, 300],
    stopReasons: { tool_use: 12 },
    lastInterruptionMs: 1000 + 11, // at/after the last message ts -> "interrupted"
  };

  // Session B: 3 turns, different project + model + date, ends clean (end_turn), no trailing interrupt.
  const bMessages: MessageRecord[] = [
    msg("claude:B", "beta", "/repo/beta", 5000, "2026-06-02", "claude-haiku-4-5-20251001", usage(10, 5, 1), null, [
      { name: "Bash", category: "shell", approxResultTokens: 9 },
    ]),
    msg("claude:B", "beta", "/repo/beta", 5001, "2026-06-02", "claude-haiku-4-5-20251001", usage(20, 8, 2), null, []),
    msg("claude:B", "beta", "/repo/beta", 5002, "2026-06-02", "claude-haiku-4-5-20251001", usage(5, 3, 0), null, [], "end_turn"),
  ];
  const bFriction: SessionFriction = {
    interruptions: 0,
    rejections: 0,
    compactions: 0,
    turns: 3,
    turnDurationsMs: [50],
    stopReasons: { end_turn: 1 },
  };

  const sessions: MaterializeSession[] = [
    {
      meta: { source: "claude", sessionId: "claude:A", project: "alpha", cwd: "/repo/alpha", filePath: "/repo/alpha/t.jsonl", friction: aFriction, rawTurns: 6 },
      messages: aMessages,
    },
    {
      meta: { source: "claude", sessionId: "claude:B", project: "beta", cwd: "/repo/beta", filePath: "/repo/beta/t.jsonl", friction: bFriction, rawTurns: 3 },
      messages: bMessages,
    },
  ];
  await store.materializeSessions("claude", sessions);
  await store.close();
  return path;
}

describe("snapshot SQL parity on a rich synthetic store", () => {
  test("every serve-consumed breakdown matches the JS aggregate", async () => {
    const path = await seededStore();
    const dir = join(path, "..");
    try {
      const store = await openStore({ path });
      let js, sql;
      try {
        js = aggregate(await store.readResolved(), PLUGINS, new Map());
        sql = assembleDashboard(await store.readDashboardAggregates(), PLUGINS);
      } finally {
        await store.close();
      }

      // Totals + range.
      expect(sql.totals.sessions).toBe(js.totals.sessions);
      expect(sql.totals.messages).toBe(js.totals.messages);
      expect(sql.totals.total).toBe(js.totals.total);
      expect(sql.totals.cost).toBeCloseTo(js.totals.cost, 6);
      expect(sql.range).toEqual(js.range);

      // Daily (per date), tokens exact + cost close.
      const jsDaily = new Map(js.daily.map((d) => [d.date, d]));
      expect(sql.daily.length).toBe(js.daily.length);
      for (const d of sql.daily) {
        const j = jsDaily.get(d.date)!;
        expect({ ...d, cost: 0 }).toEqual({ ...j, cost: 0 });
        expect(d.cost).toBeCloseTo(j.cost, 6);
      }

      const named = (rows: typeof js.byModel) => new Map(rows.map((r) => [r.name, { messages: r.messages, total: r.total, sessions: r.meta?.sessions, plugin: r.meta?.plugin }]));
      expect(named(sql.byModel)).toEqual(named(js.byModel));
      expect(named(sql.bySource)).toEqual(named(js.bySource));
      expect(named(sql.bySkill)).toEqual(named(js.bySkill));
      expect(named(sql.byProject)).toEqual(named(js.byProject));
      for (const list of ["byModel", "bySource", "bySkill", "byProject"] as const) {
        const j = new Map(js[list].map((r) => [r.name, r.cost]));
        for (const r of sql[list]) expect(r.cost).toBeCloseTo(j.get(r.name)!, 6);
      }

      expect(sql.byModelDaily).toEqual(js.byModelDaily);
      expect(sql.bySkillDaily).toEqual(js.bySkillDaily);

      // Tools / categories / MCP / heaviest.
      expect(new Map(sql.byTool.map((t) => [t.name, t]))).toEqual(new Map(js.byTool.map((t) => [t.name, t])));
      expect(new Map(sql.byToolCategory.map((t) => [t.category, t]))).toEqual(new Map(js.byToolCategory.map((t) => [t.category, t])));
      expect(new Map(sql.byMcpServer.map((m) => [m.server, m]))).toEqual(new Map(js.byMcpServer.map((m) => [m.server, m])));
      expect(sql.heaviestToolResults).toEqual(js.heaviestToolResults);

      // Per-project friction + global friction/outcome/growth scalars.
      const jsProjFriction = new Map(js.byProject.map((p) => [p.name, p.meta?.friction]));
      for (const p of sql.byProject) expect(p.meta?.friction).toEqual(jsProjFriction.get(p.name));
      expect(sql.frictionTotals).toEqual(js.frictionTotals);
      expect(sql.outcomeCounts).toEqual(js.outcomeCounts);
      expect(sql.highTokenGrowthSessions).toBe(js.highTokenGrowthSessions);

      // The crafted data must actually exercise the hard paths (else parity is vacuous).
      expect(js.highTokenGrowthSessions).toBeGreaterThanOrEqual(1); // session A grows >= 5x
      expect(js.outcomeCounts.interrupted).toBeGreaterThanOrEqual(1); // session A interrupted
      expect(js.outcomeCounts.clean).toBeGreaterThanOrEqual(1); // session B clean
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
