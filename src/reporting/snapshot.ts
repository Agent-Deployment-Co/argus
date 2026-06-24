// Assemble the dashboard snapshot from pre-grouped SQL inputs (#121) instead of a JS walk over every
// message. `readDashboardAggregates` does the GROUP BY work in SQLite; this is the pure shaping +
// per-model pricing step. It produces the same `Dashboard` the JS `aggregate()` does for the serve
// path (sessions omitted — the web app reads them from /api/sessions), so the snapshot builds without
// materializing the full per-turn usage-row set. The JS `aggregate()` stays the sync path's builder.
import { foldPlugins } from "./aggregate.ts";
import { skillPlugin } from "./inventory.ts";
import { cost, unpricedModels } from "../pricing.ts";
import { CATEGORY_LABELS, parseMcpTool, toolDisplayName, UNATTRIBUTED_SKILL } from "../tool-categories.ts";
import type { DashboardAggregates } from "../store/store-contract.ts";
import {
  addUsage,
  type Dashboard,
  type DayBucket,
  emptyUsage,
  type NamedUsage,
  type PluginInfo,
  totalTokens,
  type ToolCategoryStat,
  type ToolStat,
  type Usage,
} from "../types.ts";

/** Build the serve snapshot Dashboard from the SQL-grouped inputs. Pure: no DB, no clock. Cost is
 *  priced per `(dimension, model)` in JS exactly as the JS aggregate does — pricing is linear, so
 *  SUM-then-price equals price-then-SUM. `sessions` is empty (the serve payload omits per-session rows). */
export function assembleDashboard(agg: DashboardAggregates, plugins: Map<string, PluginInfo>): Dashboard {
  // ---- daily / totals / byModel / byModelDaily, all from (date, model) usage sums ----
  const dayMap = new Map<string, DayBucket>();
  const modelDayMap = new Map<string, Map<string, number>>();
  const modelMap = new Map<string, { u: Usage; messages: number; cost: number }>();
  const totalUsage = emptyUsage();
  let totalCost = 0;
  let totalMessages = 0;
  for (const r of agg.usageByDateModel) {
    const c = cost(r.usage, r.model);
    let day = dayMap.get(r.date);
    if (!day) {
      day = { date: r.date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
      dayMap.set(r.date, day);
    }
    day.input += r.usage.input;
    day.output += r.usage.output;
    day.cacheRead += r.usage.cacheRead;
    day.cacheWrite += r.usage.cacheWrite5m + r.usage.cacheWrite1h;
    day.total += totalTokens(r.usage);
    day.cost += c;

    let mdRow = modelDayMap.get(r.date);
    if (!mdRow) {
      mdRow = new Map();
      modelDayMap.set(r.date, mdRow);
    }
    mdRow.set(r.model, (mdRow.get(r.model) ?? 0) + totalTokens(r.usage));

    const md = modelMap.get(r.model) ?? { u: emptyUsage(), messages: 0, cost: 0 };
    addUsage(md.u, r.usage);
    md.messages += r.messages;
    md.cost += c;
    modelMap.set(r.model, md);

    addUsage(totalUsage, r.usage);
    totalCost += c;
    totalMessages += r.messages;
  }
  const dates = [...dayMap.keys()].sort();
  const daily = dates.map((d) => dayMap.get(d)!);
  const byModelDaily = dates.map((d) => ({ date: d, byModel: Object.fromEntries(modelDayMap.get(d) ?? []) }));

  // ---- bySkillDaily, from (date, skill) token totals ----
  const skillDayMap = new Map<string, Map<string, number>>();
  for (const r of agg.skillTokensByDate) {
    let row = skillDayMap.get(r.date);
    if (!row) {
      row = new Map();
      skillDayMap.set(r.date, row);
    }
    row.set(r.skill, (row.get(r.skill) ?? 0) + r.total);
  }
  const bySkillDaily = dates.map((d) => ({ date: d, bySkill: Object.fromEntries(skillDayMap.get(d) ?? []) }));

  const byModel: NamedUsage[] = [...modelMap.entries()]
    .map(([name, v]) => ({ name, messages: v.messages, total: totalTokens(v.u), cost: v.cost }))
    .sort((a, b) => b.total - a.total);

  // ---- bySource / byProject / bySkill: fold (dimension, model) rows, price per model ----
  const sessionsBySource = new Map(agg.sessionsBySource.map((r) => [r.source, r.sessions]));
  const sessionsByProject = new Map(agg.sessionsByProject.map((r) => [r.project, r.sessions]));
  const projectFriction = new Map(agg.projectFriction.map((r) => [r.project, r.friction]));

  const foldByDimension = <R extends { model: string; usage: Usage; messages: number }>(
    rows: R[],
    keyOf: (row: R) => string,
  ): Map<string, { u: Usage; messages: number; cost: number }> => {
    const map = new Map<string, { u: Usage; messages: number; cost: number }>();
    for (const r of rows) {
      const key = keyOf(r);
      const entry = map.get(key) ?? { u: emptyUsage(), messages: 0, cost: 0 };
      addUsage(entry.u, r.usage);
      entry.messages += r.messages;
      entry.cost += cost(r.usage, r.model);
      map.set(key, entry);
    }
    return map;
  };

  const bySource: NamedUsage[] = [...foldByDimension(agg.usageBySourceModel, (r) => r.source).entries()]
    .map(([name, v]) => ({
      name,
      messages: v.messages,
      total: totalTokens(v.u),
      cost: v.cost,
      meta: { sessions: sessionsBySource.get(name) ?? 0 },
    }))
    .sort((a, b) => b.total - a.total);

  const bySkill: NamedUsage[] = [...foldByDimension(agg.usageBySkillModel, (r) => r.skill || UNATTRIBUTED_SKILL).entries()]
    .map(([name, v]) => ({
      name,
      messages: v.messages,
      total: totalTokens(v.u),
      cost: v.cost,
      meta: { plugin: skillPlugin(name, plugins) },
    }))
    .sort((a, b) => b.total - a.total);

  const byProject: NamedUsage[] = [...foldByDimension(agg.usageByProjectModel, (r) => r.project).entries()]
    .map(([name, v]) => {
      const friction = projectFriction.get(name);
      const meta: NamedUsage["meta"] = { sessions: sessionsByProject.get(name) ?? 0 };
      if (friction) meta.friction = friction;
      return { name, messages: v.messages, total: totalTokens(v.u), cost: v.cost, meta };
    })
    .sort((a, b) => b.total - a.total);

  // ---- tool result sizes (source-scoped) + filtered call counts ----
  const resultTokensByTool = new Map(agg.toolResultStats.map((r) => [r.tool, r.approxTokens]));

  const byTool: ToolStat[] = agg.byTool
    .map((r) => ({
      name: r.tool,
      category: r.category,
      display: toolDisplayName(r.tool),
      calls: r.calls,
      sessions: r.sessions,
      approxResultTokens: resultTokensByTool.get(r.tool) ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  // Per-category result tokens = sum of source-scoped per-tool tokens over the (filtered) tools seen
  // in that category — mirrors the JS aggregate, which sums toolResults over toolMap entries.
  const categoryApprox = new Map<string, number>();
  for (const r of agg.byTool) {
    categoryApprox.set(r.category, (categoryApprox.get(r.category) ?? 0) + (resultTokensByTool.get(r.tool) ?? 0));
  }
  const byToolCategory: ToolCategoryStat[] = agg.byToolCategory
    .map((r) => ({
      category: r.category,
      label: CATEGORY_LABELS[r.category],
      calls: r.calls,
      tools: r.tools,
      sessions: r.sessions,
      approxResultTokens: categoryApprox.get(r.category) ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  // ---- MCP servers: calls (filtered) + topTools + source-scoped result tokens ----
  const toolsByServer = new Map<string, Array<{ tool: string; count: number }>>();
  for (const r of agg.mcpServerTools) {
    const list = toolsByServer.get(r.server) ?? [];
    list.push({ tool: r.tool, count: r.count });
    toolsByServer.set(r.server, list);
  }
  const byMcpServer = agg.mcpServers
    .map((s) => {
      let approxResultTokens = 0;
      const topTools = (toolsByServer.get(s.server) ?? [])
        .map(({ tool, count }) => {
          approxResultTokens += resultTokensByTool.get(tool) ?? 0;
          return { tool: parseMcpTool(tool)?.tool ?? tool, count };
        })
        .sort((a, b) => b.count - a.count);
      return { server: s.server, calls: s.calls, approxResultTokens, topTools };
    })
    .sort((a, b) => b.calls - a.calls);

  const skillInvocations = agg.skillInvocations
    .map((r) => ({ name: r.skill, count: r.count, plugin: skillPlugin(r.skill, plugins), sampleArgs: r.sampleArgs }))
    .sort((a, b) => b.count - a.count);

  const heaviestToolResults = agg.toolResultStats
    .map((r) => ({ tool: r.tool, count: r.count, approxTokens: r.approxTokens }))
    .sort((a, b) => b.approxTokens - a.approxTokens)
    .slice(0, 15);

  const byPlugin = foldPlugins(bySkill, byMcpServer, plugins);

  return {
    generatedAtMs: 0,
    range: { start: dates[0] || "", end: dates[dates.length - 1] || "" },
    totals: {
      // Each session has exactly one source, so the distinct-session total is the sum across sources.
      sessions: agg.sessionsBySource.reduce((n, r) => n + r.sessions, 0),
      messages: totalMessages,
      usage: totalUsage,
      total: totalTokens(totalUsage),
      cost: totalCost,
    },
    unpriced: unpricedModels(),
    daily,
    byModelDaily,
    bySkillDaily,
    byModel,
    bySource,
    bySkill,
    skillInvocations,
    byMcpServer,
    byTool,
    byToolCategory,
    heaviestToolResults,
    byPlugin,
    byProject,
    // The serve payload omits per-session rows (the web app reads them from /api/sessions).
    sessions: [],
    frictionTotals: agg.frictionTotals,
    highTokenGrowthSessions: agg.highTokenGrowthSessions,
    outcomeCounts: agg.outcomeCounts,
  };
}
