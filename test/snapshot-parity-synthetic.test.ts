// #121 parity, richer cases: seed a store directly via materializeSessions with crafted data the small
// fixtures don't exercise — multiple sessions/projects/models/dates, a 12-turn session with growing
// token use (token-growth recommendation input), friction in metadata, an interrupted vs a clean
// outcome, a cross-date session, MCP + Skill calls, and per-call result tokens. Then assert the JS walk
// over readResolved equals the SQL snapshot over readDashboardAggregates on the SAME store, both
// unfiltered and under a NARROWING date filter (which exercises the date-windowed outcome path).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../src/reporting/aggregate.ts";
import { assembleDashboard } from "../src/reporting/snapshot.ts";
import { openStore } from "../src/store/store.ts";
import type { MaterializeSession, ResolvedQuery } from "../src/store/store-contract.ts";
import {
  type Dashboard,
  emptyUsage,
  type MessageRecord,
  type PluginInfo,
  type SessionFriction,
  type ToolUse,
  type Usage,
} from "../src/types.ts";

const PLUGINS = new Map<string, PluginInfo>();
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

async function seededStorePath(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "argus-parity-syn-"));
  dirs.push(dir);
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

  // Session C: spans TWO dates with an interruption BETWEEN the 06-01 message and the 06-02 messages.
  // Whole-session: last msg (06-02) is end_turn and the interruption precedes it -> "clean". Windowed to
  // until=06-01: the last in-window msg is the 06-01 one and the interruption is at/after it ->
  // "interrupted". This is the exact divergence the date-windowed outcome fix must get right.
  const cMessages: MessageRecord[] = [
    msg("claude:C", "gamma", "/repo/gamma", 8000, "2026-06-01", "claude-sonnet-4-6", usage(30, 10, 5), null, [], "tool_use"),
    msg("claude:C", "gamma", "/repo/gamma", 9000, "2026-06-02", "claude-sonnet-4-6", usage(15, 6, 1), null, [], "end_turn"),
  ];
  const cFriction: SessionFriction = {
    interruptions: 1,
    rejections: 0,
    compactions: 0,
    turns: 2,
    turnDurationsMs: [42],
    stopReasons: { tool_use: 1, end_turn: 1 },
    lastInterruptionMs: 8500, // between the 06-01 msg (8000) and the 06-02 msg (9000)
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
    {
      meta: { source: "claude", sessionId: "claude:C", project: "gamma", cwd: "/repo/gamma", filePath: "/repo/gamma/t.jsonl", friction: cFriction, rawTurns: 2 },
      messages: cMessages,
    },
  ];
  await store.materializeSessions("claude", sessions);
  await store.close();
  return path;
}

async function buildBoth(path: string, query?: ResolvedQuery): Promise<{ js: Dashboard; sql: Dashboard }> {
  const store = await openStore({ path });
  try {
    const js = aggregate(await store.readResolved(query), PLUGINS, new Map());
    const sql = assembleDashboard(await store.readDashboardAggregates(query), PLUGINS);
    return { js, sql };
  } finally {
    await store.close();
  }
}

function assertParity(js: Dashboard, sql: Dashboard): void {
  expect(sql.totals.sessions).toBe(js.totals.sessions);
  expect(sql.totals.messages).toBe(js.totals.messages);
  expect(sql.totals.total).toBe(js.totals.total);
  expect(sql.totals.cost).toBeCloseTo(js.totals.cost, 6);
  expect(sql.range).toEqual(js.range);

  const jsDaily = new Map(js.daily.map((d) => [d.date, d]));
  expect(sql.daily.length).toBe(js.daily.length);
  for (const d of sql.daily) {
    const j = jsDaily.get(d.date)!;
    expect({ ...d, cost: 0 }).toEqual({ ...j, cost: 0 });
    expect(d.cost).toBeCloseTo(j.cost, 6);
  }

  const named = (rows: typeof js.byModel) =>
    new Map(rows.map((r) => [r.name, { messages: r.messages, total: r.total, sessions: r.meta?.sessions, plugin: r.meta?.plugin }]));
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

  expect(new Map(sql.byTool.map((t) => [t.name, t]))).toEqual(new Map(js.byTool.map((t) => [t.name, t])));
  expect(new Map(sql.byToolCategory.map((t) => [t.category, t]))).toEqual(new Map(js.byToolCategory.map((t) => [t.category, t])));
  expect(new Map(sql.byMcpServer.map((m) => [m.server, m]))).toEqual(new Map(js.byMcpServer.map((m) => [m.server, m])));
  expect(sql.heaviestToolResults).toEqual(js.heaviestToolResults);

  const jsProjFriction = new Map(js.byProject.map((p) => [p.name, p.meta?.friction]));
  for (const p of sql.byProject) expect(p.meta?.friction).toEqual(jsProjFriction.get(p.name));
  expect(sql.frictionTotals).toEqual(js.frictionTotals);
  expect(sql.outcomeCounts).toEqual(js.outcomeCounts);
  expect(sql.highTokenGrowthSessions).toBe(js.highTokenGrowthSessions);
}

describe("snapshot SQL parity on a rich synthetic store", () => {
  test("every serve-consumed breakdown matches the JS aggregate (unfiltered)", async () => {
    const path = await seededStorePath();
    const { js, sql } = await buildBoth(path);
    assertParity(js, sql);
    // The crafted data must actually exercise the hard paths (else parity is vacuous).
    expect(js.highTokenGrowthSessions).toBeGreaterThanOrEqual(1); // session A grows >= 5x
    expect(js.outcomeCounts.interrupted).toBeGreaterThanOrEqual(1); // session A interrupted
    expect(js.outcomeCounts.clean).toBeGreaterThanOrEqual(1); // sessions B + C clean (full window)
  });

  test("a narrowing date filter classifies the windowed last message, not the session end", async () => {
    const path = await seededStorePath();
    const { js, sql } = await buildBoth(path, { until: "2026-06-01" });
    assertParity(js, sql);
    // Session B (06-02) is excluded; session C's only in-window msg is 06-01 with the interruption at/
    // after it, so C flips clean -> interrupted under the window. Both paths must agree on that flip.
    expect(js.totals.sessions).toBe(2); // A + C (B excluded)
    expect(sql.outcomeCounts.interrupted).toBe(js.outcomeCounts.interrupted);
    expect(js.outcomeCounts.interrupted).toBeGreaterThanOrEqual(2); // A and C both interrupted in-window
    expect(js.outcomeCounts.clean).toBe(0); // C's clean 06-02 turn is out of window
  });
});
