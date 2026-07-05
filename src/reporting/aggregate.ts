// Per-session row assembly + plugin folding. Once the home of the monolithic `aggregate()` that built
// the whole Dashboard from a JS walk over every message; #217 removed that (serve reads each view
// straight off argus.db via per-view store methods + endpoints). What remains is shared, per-session
// logic: `buildSessionRow` (the on-demand /api/session/:id + /api/sessions detail) and `foldPlugins`
// (the /api/plugins builder).
import { cost } from "../pricing.ts";
import {
  addUsage,
  emptyUsage,
  type MessageRecord,
  type NamedUsage,
  type PluginInfo,
  type PluginRow,
  type SessionFriction,
  type SessionHealth,
  type SessionMeta,
  type SessionRow,
  totalTokens,
  type Usage,
} from "../types.ts";
import type { TaskFact } from "../store/store-contract.ts";

function usageCost(u: Usage, model: string): number {
  return cost(u, model);
}

/** Fold per-skill + per-MCP-server usage into per-plugin rows, seeding all known plugins so
 *  enabled-but-unused ones still surface. Backs the /api/plugins builder. */
export function foldPlugins(
  bySkill: NamedUsage[],
  byMcpServer: Array<{ server: string; calls: number }>,
  plugins: Map<string, PluginInfo>,
): PluginRow[] {
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
  return [...pluginAgg.values()].sort((a, b) => {
    if (a.used !== b.used) return a.used ? -1 : 1;
    return b.skillTokens - a.skillTokens;
  });
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
  };
}

/** Build one session's full row from its (timestamp-ordered) messages, metadata, heuristic summary,
 *  and extracted tasks. Shared by the on-demand /api/session/:id detail and the /api/sessions list, so
 *  both produce an identical SessionRow. `msgs` must be non-empty. */
export function buildSessionRow(
  sid: string,
  msgs: MessageRecord[],
  meta: SessionMeta | undefined,
  summary: string,
  tasks: TaskFact[],
): SessionRow {
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
  return {
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
    summary,
    health: {
      ...sessionHealth(msgs, meta?.friction),
      turns: meta?.rawTurns ?? meta?.friction?.turns ?? null,
    },
    tasks,
  };
}
