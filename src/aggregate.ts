import { skillPlugin } from "./inventory.ts";
import { cost, unpricedModels } from "./pricing.ts";
import { CATEGORY_LABELS, parseMcpTool, toolDisplayName, type ToolCategory } from "./tool-categories.ts";
import {
  addUsage,
  type Dashboard,
  emptyUsage,
  type DayBucket,
  type FrictionTotals,
  type MessageRecord,
  type NamedUsage,
  type ParseResult,
  type PluginInfo,
  type PluginRow,
  type SessionFriction,
  type SessionHealth,
  type SessionRow,
  type ToolCategoryStat,
  type ToolStat,
  totalTokens,
  type Usage,
} from "./types.ts";

// Re-export the dashboard types (now defined in types.ts) for existing importers.
export type {
  Dashboard,
  DayBucket,
  NamedUsage,
  PluginRow,
  SessionRow,
  ToolCategoryStat,
  ToolStat,
} from "./types.ts";

function usageCost(u: Usage, model: string): number {
  return cost(u, model);
}

// ---- session health (#38) ----

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Tokens-per-message growth within a session: mean total tokens of the last decile of
 * messages over the first decile. Cache reads grow with context, so a high ratio flags a
 * session whose late turns were paying for a long history — a restart candidate.
 */
function tokenGrowth(msgs: MessageRecord[]): number | null {
  if (msgs.length < 10) return null;
  const k = Math.floor(msgs.length / 10);
  const mean = (slice: MessageRecord[]) =>
    slice.reduce((sum, m) => sum + totalTokens(m.usage), 0) / slice.length;
  const first = mean(msgs.slice(0, k));
  return first > 0 ? mean(msgs.slice(-k)) / first : null;
}

function sessionOutcome(
  msgs: MessageRecord[],
  friction: SessionFriction | undefined,
): SessionHealth["outcome"] {
  // The user interrupted after the assistant's last message and never re-prompted.
  const lastMessageTs = msgs[msgs.length - 1]!.ts;
  if (friction?.lastInterruptionMs != null && friction.lastInterruptionMs >= lastMessageTs) {
    return "interrupted";
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const stopReason = msgs[i]!.stopReason;
    if (!stopReason) continue;
    // A trailing tool_use means the transcript ends mid-work — possibly a live session —
    // so it stays "unknown" rather than guessing "abandoned".
    return stopReason === "end_turn" || stopReason === "stop_sequence" ? "clean" : "unknown";
  }
  return "unknown";
}

/** msgs must be in timestamp order (parse guarantees it). */
function sessionHealth(msgs: MessageRecord[], friction: SessionFriction | undefined): SessionHealth {
  return {
    interruptions: friction?.interruptions ?? null,
    rejections: friction?.rejections ?? null,
    compactions: friction?.compactions ?? null,
    turns: friction?.turns ?? null,
    medianTurnMs: friction ? median(friction.turnDurationsMs) : null,
    maxTurnMs: friction?.turnDurationsMs.length ? Math.max(...friction.turnDurationsMs) : null,
    stopReasons: friction?.stopReasons ?? null,
    tokenGrowth: tokenGrowth(msgs),
    outcome: sessionOutcome(msgs, friction),
  };
}

export function aggregate(
  parsed: ParseResult,
  plugins: Map<string, PluginInfo>,
  summaries: Map<string, string>,
): Dashboard {
  const { messages, sessions, toolResults } = parsed;

  // ---- totals + daily ----
  const totalUsage = emptyUsage();
  let totalCost = 0;
  const dayMap = new Map<string, DayBucket>();
  const modelDayMap = new Map<string, Map<string, number>>();
  const skillDayMap = new Map<string, Map<string, number>>();
  const modelMap = new Map<string, { u: Usage; messages: number }>();
  const sourceMap = new Map<string, { u: Usage; messages: number; sessions: Set<string> }>();
  const skillMap = new Map<string, { u: Usage; messages: number }>();
  const projectMap = new Map<string, { u: Usage; messages: number; sessions: Set<string> }>();

  // skill invocations (explicit Skill tool calls)
  const invMap = new Map<string, { count: number; sampleArgs: string }>();
  // mcp servers
  const mcpMap = new Map<string, { calls: number; tools: Map<string, number> }>();
  // Every tool call, keyed by raw name for tool ranking and category rollup.
  const toolMap = new Map<
    string,
    { category: ToolCategory; display: string; calls: number; sessions: Set<string> }
  >();

  for (const m of messages) {
    const c = usageCost(m.usage, m.model);
    totalCost += c;
    addUsage(totalUsage, m.usage);

    // daily
    let day = dayMap.get(m.date);
    if (!day) {
      day = { date: m.date, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
      dayMap.set(m.date, day);
    }
    day.input += m.usage.input;
    day.output += m.usage.output;
    day.cacheRead += m.usage.cacheRead;
    day.cacheWrite += m.usage.cacheWrite5m + m.usage.cacheWrite1h;
    day.total += totalTokens(m.usage);
    day.cost += c;

    // model
    const md = modelMap.get(m.model) || { u: emptyUsage(), messages: 0 };
    addUsage(md.u, m.usage);
    md.messages++;
    modelMap.set(m.model, md);

    // model × day
    let mdRow = modelDayMap.get(m.date);
    if (!mdRow) { mdRow = new Map(); modelDayMap.set(m.date, mdRow); }
    mdRow.set(m.model, (mdRow.get(m.model) ?? 0) + totalTokens(m.usage));

    // skill × day (exclude "(none)" — unattributed messages dominate and aren't useful for trend)
    if (m.attributionSkill) {
      let sdRow = skillDayMap.get(m.date);
      if (!sdRow) { sdRow = new Map(); skillDayMap.set(m.date, sdRow); }
      sdRow.set(m.attributionSkill, (sdRow.get(m.attributionSkill) ?? 0) + totalTokens(m.usage));
    }

    // source
    const src = sourceMap.get(m.source) || { u: emptyUsage(), messages: 0, sessions: new Set() };
    addUsage(src.u, m.usage);
    src.messages++;
    src.sessions.add(m.sessionId);
    sourceMap.set(m.source, src);

    // skill attribution
    const skill = m.attributionSkill ?? "(none)";
    const sk = skillMap.get(skill) || { u: emptyUsage(), messages: 0 };
    addUsage(sk.u, m.usage);
    sk.messages++;
    skillMap.set(skill, sk);

    // project
    const pj = projectMap.get(m.project) || { u: emptyUsage(), messages: 0, sessions: new Set() };
    addUsage(pj.u, m.usage);
    pj.messages++;
    pj.sessions.add(m.sessionId);
    projectMap.set(m.project, pj);

    // tool-derived: per-tool ranking + skill invocations + mcp calls
    for (const tu of m.toolUses) {
      const t = toolMap.get(tu.name) || {
        category: tu.category,
        display: toolDisplayName(tu.name),
        calls: 0,
        sessions: new Set<string>(),
      };
      t.calls++;
      t.sessions.add(m.sessionId);
      toolMap.set(tu.name, t);

      if ((tu.name === "Skill" || tu.name === "activate_skill") && tu.skill) {
        const inv = invMap.get(tu.skill) || { count: 0, sampleArgs: "" };
        inv.count++;
        if (!inv.sampleArgs && tu.args) inv.sampleArgs = tu.args;
        invMap.set(tu.skill, inv);
      }
      if (tu.mcpServer) {
        const s = mcpMap.get(tu.mcpServer) || { calls: 0, tools: new Map() };
        s.calls++;
        s.tools.set(tu.name, (s.tools.get(tu.name) || 0) + 1);
        mcpMap.set(tu.mcpServer, s);
      }
    }
  }

  const dates = [...dayMap.keys()].sort();
  const daily = dates.map((d) => dayMap.get(d)!);
  const byModelDaily = dates.map((d) => ({ date: d, byModel: Object.fromEntries(modelDayMap.get(d) ?? []) }));
  const bySkillDaily = dates.map((d) => ({ date: d, bySkill: Object.fromEntries(skillDayMap.get(d) ?? []) }));

  // Exact per-entity cost (re-walk messages so each message is priced by its own model;
  // summing usage first and pricing once would mis-price sessions that mix models).
  const skillCost = new Map<string, number>();
  const projectCost = new Map<string, number>();
  const sourceCost = new Map<string, number>();
  const modelCost = new Map<string, number>();
  for (const m of messages) {
    const c = usageCost(m.usage, m.model);
    const sk = m.attributionSkill ?? "(none)";
    skillCost.set(sk, (skillCost.get(sk) || 0) + c);
    projectCost.set(m.project, (projectCost.get(m.project) || 0) + c);
    sourceCost.set(m.source, (sourceCost.get(m.source) || 0) + c);
    modelCost.set(m.model, (modelCost.get(m.model) || 0) + c);
  }

  const byModel: NamedUsage[] = [...modelMap.entries()]
    .map(([name, v]) => ({ name, messages: v.messages, total: totalTokens(v.u), cost: modelCost.get(name) || 0 }))
    .sort((a, b) => b.total - a.total);

  const bySource: NamedUsage[] = [...sourceMap.entries()]
    .map(([name, v]) => ({
      name,
      messages: v.messages,
      total: totalTokens(v.u),
      cost: sourceCost.get(name) || 0,
      meta: { sessions: v.sessions.size },
    }))
    .sort((a, b) => b.total - a.total);

  const bySkill: NamedUsage[] = [...skillMap.entries()]
    .map(([name, v]) => ({
      name,
      messages: v.messages,
      total: totalTokens(v.u),
      cost: skillCost.get(name) || 0,
      meta: { plugin: skillPlugin(name, plugins) },
    }))
    .sort((a, b) => b.total - a.total);

  const byProject: NamedUsage[] = [...projectMap.entries()]
    .map(([name, v]) => ({
      name,
      messages: v.messages,
      total: totalTokens(v.u),
      cost: projectCost.get(name) || 0,
      meta: { sessions: v.sessions.size },
    }))
    .sort((a, b) => b.total - a.total);

  const skillInvocations = [...invMap.entries()]
    .map(([name, v]) => ({ name, count: v.count, plugin: skillPlugin(name, plugins), sampleArgs: v.sampleArgs }))
    .sort((a, b) => b.count - a.count);

  const byMcpServer = [...mcpMap.entries()]
    .map(([server, v]) => {
      let approx = 0;
      const topTools = [...v.tools.entries()]
        .map(([tool, count]) => {
          approx += toolResults.get(tool)?.approxTokens || 0;
          // Canonical mcp__server__tool split.
          return { tool: parseMcpTool(tool)?.tool ?? tool, count };
        })
        .sort((a, b) => b.count - a.count);
      return { server, calls: v.calls, approxResultTokens: approx, topTools };
    })
    .sort((a, b) => b.calls - a.calls);

  // ---- per-tool ranking + category rollup ----
  const byTool: ToolStat[] = [...toolMap.entries()]
    .map(([name, v]) => ({
      name,
      category: v.category,
      display: v.display,
      calls: v.calls,
      sessions: v.sessions.size,
      approxResultTokens: toolResults.get(name)?.approxTokens || 0,
    }))
    .sort((a, b) => b.calls - a.calls);

  const catMap = new Map<
    ToolCategory,
    { calls: number; tools: Set<string>; sessions: Set<string>; approx: number }
  >();
  for (const [name, v] of toolMap) {
    const c = catMap.get(v.category) || { calls: 0, tools: new Set(), sessions: new Set(), approx: 0 };
    c.calls += v.calls;
    c.tools.add(name);
    for (const sid of v.sessions) c.sessions.add(sid);
    c.approx += toolResults.get(name)?.approxTokens || 0;
    catMap.set(v.category, c);
  }
  const byToolCategory: ToolCategoryStat[] = [...catMap.entries()]
    .map(([category, v]) => ({
      category,
      label: CATEGORY_LABELS[category],
      calls: v.calls,
      tools: v.tools.size,
      sessions: v.sessions.size,
      approxResultTokens: v.approx,
    }))
    .sort((a, b) => b.calls - a.calls);

  const heaviestToolResults = [...toolResults.entries()]
    .map(([tool, s]) => ({ tool, count: s.count, approxTokens: s.approxTokens }))
    .sort((a, b) => b.approxTokens - a.approxTokens)
    .slice(0, 15);

  // ---- plugins (fold skills + mcp usage; include enabled-but-unused) ----
  const pluginAgg = new Map<string, PluginRow>();
  const ensurePlugin = (name: string): PluginRow => {
    let row = pluginAgg.get(name);
    if (!row) {
      const info = plugins.get(name);
      row = {
        name,
        marketplace: info?.marketplace || "",
        enabled: info?.enabled ?? false,
        used: false,
        version: info?.version,
        installedAt: info?.installedAt,
        skills: [],
        skillMessages: 0,
        skillTokens: 0,
        skillCost: 0,
        mcpCalls: 0,
      };
      pluginAgg.set(name, row);
    }
    return row;
  };
  // seed all known plugins so unused-but-enabled ones show up
  for (const name of plugins.keys()) ensurePlugin(name);

  for (const s of bySkill) {
    const pname = (s.meta?.plugin as string | null) ?? null;
    if (!pname) continue;
    const row = ensurePlugin(pname);
    row.used = true;
    if (!row.skills.includes(s.name)) row.skills.push(s.name);
    row.skillMessages += s.messages;
    row.skillTokens += s.total;
    row.skillCost += s.cost;
  }
  // attribute MCP servers to plugins by name match (best-effort).
  for (const s of byMcpServer) {
    if (pluginAgg.has(s.server)) {
      const row = ensurePlugin(s.server);
      row.used = true;
      row.mcpCalls += s.calls;
    }
  }
  const byPlugin = [...pluginAgg.values()].sort((a, b) => {
    if (a.used !== b.used) return a.used ? -1 : 1;
    return b.skillTokens - a.skillTokens;
  });

  // ---- sessions ----
  const bySession = new Map<string, MessageRecord[]>();
  for (const m of messages) {
    (bySession.get(m.sessionId) || bySession.set(m.sessionId, []).get(m.sessionId)!).push(m);
  }
  const sessionRows: SessionRow[] = [];
  for (const [sid, msgs] of bySession) {
    const meta = sessions.get(sid);
    const u = emptyUsage();
    let c = 0;
    const models = new Set<string>();
    const skillCounts = new Map<string, number>();
    const toolCounts: Record<string, number> = {};
    const files = new Set<string>();
    for (const m of msgs) {
      addUsage(u, m.usage);
      c += usageCost(m.usage, m.model);
      models.add(m.model);
      if (m.attributionSkill) skillCounts.set(m.attributionSkill, (skillCounts.get(m.attributionSkill) || 0) + 1);
      for (const tu of m.toolUses) {
        toolCounts[tu.name] = (toolCounts[tu.name] || 0) + 1;
        if (tu.filePath) files.add(tu.filePath);
      }
    }
    const start = msgs[0]!.ts;
    const end = msgs[msgs.length - 1]!.ts;
    const topSkills = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    sessionRows.push({
      source: meta?.source || msgs[0]!.source,
      sessionId: sid,
      project: meta?.project || msgs[0]!.project,
      start,
      end,
      durationMs: end - start,
      messages: msgs.length,
      userMessages: meta?.userMessages ?? null,
      agentMessages: meta?.agentMessages ?? null,
      rawTurns: meta?.rawTurns ?? null,
      models: [...models],
      topSkills,
      toolCounts,
      filesTouched: [...files],
      total: totalTokens(u),
      cost: c,
      firstPrompt: meta?.firstPrompt || "",
      summary: summaries.get(sid) || "",
      health: {
        ...sessionHealth(msgs, meta?.friction),
        turns: meta?.rawTurns ?? meta?.friction?.turns ?? null,
      },
      tasks: parsed.tasksBySession?.get(sid) ?? [],
    });
  }
  sessionRows.sort((a, b) => b.start - a.start);

  // ---- friction rollups (#38): totals + per-project, over friction-observable sessions ----
  const emptyFrictionTotals = (): FrictionTotals => ({
    observableSessions: 0,
    interruptions: 0,
    rejections: 0,
    compactions: 0,
    turns: 0,
  });
  const frictionTotals = emptyFrictionTotals();
  const projectFriction = new Map<string, FrictionTotals>();
  for (const row of sessionRows) {
    const h = row.health;
    if (h.interruptions == null) continue; // friction not observable for this source
    const pf = projectFriction.get(row.project) ?? emptyFrictionTotals();
    if (!projectFriction.has(row.project)) projectFriction.set(row.project, pf);
    for (const bucket of [frictionTotals, pf]) {
      bucket.observableSessions++;
      bucket.interruptions += h.interruptions;
      bucket.rejections += h.rejections ?? 0;
      bucket.compactions += h.compactions ?? 0;
      bucket.turns += h.turns ?? 0;
    }
  }
  for (const project of byProject) {
    const friction = projectFriction.get(project.name);
    if (friction) project.meta = { ...project.meta, friction };
  }

  return {
    generatedAtMs: 0,
    range: { start: dates[0] || "", end: dates[dates.length - 1] || "" },
    totals: {
      sessions: bySession.size,
      messages: messages.length,
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
    sessions: sessionRows,
    frictionTotals,
  };
}
