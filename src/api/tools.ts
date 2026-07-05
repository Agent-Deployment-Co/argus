// Serve-only builders for the Tools view breakdowns (#217): skills, per-tool, per-category, MCP
// servers, and heaviest tool results. Pure functions over the store's pre-grouped rows, reusing the
// canonical tool/skill helpers so naming and categorization match the rest of the app. Replaces the
// bySkill/byTool/byToolCategory/byMcpServer/heaviestToolResults slices of the old assembleDashboard.
import { skillPlugin } from "../reporting/inventory.ts";
import {
  CATEGORY_LABELS,
  parseMcpTool,
  type ToolCategory,
  toolDisplayName,
  UNATTRIBUTED_SKILL,
} from "../tool-categories.ts";
import type { UsageGroupRow } from "../store/store-contract.ts";
import type { Dashboard, NamedUsage, PluginInfo, ToolCategoryStat, ToolStat } from "../types.ts";
import { foldNamedUsage } from "./usage.ts";

type BySkillModel = { skill: string } & UsageGroupRow;
type ToolStatRow = { tool: string; category: ToolCategory; calls: number; sessions: number };
type ToolCategoryRow = { category: ToolCategory; calls: number; tools: number; sessions: number };
type ToolResultRow = { tool: string; count: number; approxTokens: number };
type McpServerRow = { server: string; calls: number };
type McpServerToolRow = { server: string; tool: string; count: number };

export interface SkillsResponse {
  bySkill: NamedUsage[];
  bySkillDaily: Dashboard["bySkillDaily"];
}

export interface ByToolResponse {
  byTool: ToolStat[];
}

export interface ByToolCategoryResponse {
  byToolCategory: ToolCategoryStat[];
}

export interface ByMcpServerResponse {
  byMcpServer: Dashboard["byMcpServer"];
}

export interface HeaviestResultsResponse {
  heaviestToolResults: Dashboard["heaviestToolResults"];
}

/** Fold per-(skill, model) usage into per-skill rows (empty skill → "(none)"), tagging each with its
 *  owning plugin. Exposed so the plugins builder can reuse the same bySkill fold. */
export function foldBySkill(rows: BySkillModel[], plugins: Map<string, PluginInfo>): NamedUsage[] {
  return foldNamedUsage(rows, (r) => r.skill || UNATTRIBUTED_SKILL, (name) => ({ plugin: skillPlugin(name, plugins) }));
}

/** GET /api/skills — per-skill tokens/cost + the per-day stacked series (attributed skills only).
 *  `dates` is the full set of usage days in scope (from the store), so the series spans every day —
 *  emitting an empty `{}` for days with usage but no attributed skill — and its x-axis stays aligned
 *  with Activity's byModelDaily chart. (Deriving dates from `skillTokensByDate` alone, which is
 *  attributed-only, would silently drop idle days and collapse week-long gaps into adjacent bars.) */
export function buildSkills(
  rows: BySkillModel[],
  skillTokensByDate: Array<{ date: string; skill: string; total: number }>,
  dates: string[],
  plugins: Map<string, PluginInfo>,
): SkillsResponse {
  const bySkill = foldBySkill(rows, plugins);

  const skillDayMap = new Map<string, Map<string, number>>();
  for (const r of skillTokensByDate) {
    let row = skillDayMap.get(r.date);
    if (!row) {
      row = new Map();
      skillDayMap.set(r.date, row);
    }
    row.set(r.skill, (row.get(r.skill) ?? 0) + r.total);
  }
  const bySkillDaily = [...dates]
    .sort()
    .map((d) => ({ date: d, bySkill: Object.fromEntries(skillDayMap.get(d) ?? []) }));
  return { bySkill, bySkillDaily };
}

/** GET /api/tools/by-tool — per-tool call ranking with its source-scoped result-token weight. */
export function buildByTool(toolStats: ToolStatRow[], toolResultStats: ToolResultRow[]): ByToolResponse {
  const resultTokens = new Map(toolResultStats.map((r) => [r.tool, r.approxTokens]));
  const byTool: ToolStat[] = toolStats
    .map((r) => ({
      name: r.tool,
      category: r.category,
      display: toolDisplayName(r.tool),
      calls: r.calls,
      sessions: r.sessions,
      approxResultTokens: resultTokens.get(r.tool) ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls);
  return { byTool };
}

/** GET /api/tools/by-category — category rollup; result tokens summed over the tools seen per category
 *  (mirrors the old assembler, which summed per-tool tokens over the filtered tool set). */
export function buildByToolCategory(
  categoryStats: ToolCategoryRow[],
  toolStats: ToolStatRow[],
  toolResultStats: ToolResultRow[],
): ByToolCategoryResponse {
  const resultTokens = new Map(toolResultStats.map((r) => [r.tool, r.approxTokens]));
  const categoryApprox = new Map<ToolCategory, number>();
  for (const t of toolStats) {
    categoryApprox.set(t.category, (categoryApprox.get(t.category) ?? 0) + (resultTokens.get(t.tool) ?? 0));
  }
  const byToolCategory: ToolCategoryStat[] = categoryStats
    .map((r) => ({
      category: r.category,
      label: CATEGORY_LABELS[r.category],
      calls: r.calls,
      tools: r.tools,
      sessions: r.sessions,
      approxResultTokens: categoryApprox.get(r.category) ?? 0,
    }))
    .sort((a, b) => b.calls - a.calls);
  return { byToolCategory };
}

/** GET /api/tools/by-mcp-server — calls per MCP server + its top tools + source-scoped result weight. */
export function buildByMcpServer(
  servers: McpServerRow[],
  serverTools: McpServerToolRow[],
  toolResultStats: ToolResultRow[],
): ByMcpServerResponse {
  const resultTokens = new Map(toolResultStats.map((r) => [r.tool, r.approxTokens]));
  const toolsByServer = new Map<string, Array<{ tool: string; count: number }>>();
  for (const r of serverTools) {
    const list = toolsByServer.get(r.server) ?? [];
    list.push({ tool: r.tool, count: r.count });
    toolsByServer.set(r.server, list);
  }
  const byMcpServer = servers
    .map((s) => {
      let approxResultTokens = 0;
      const topTools = (toolsByServer.get(s.server) ?? [])
        .map(({ tool, count }) => {
          approxResultTokens += resultTokens.get(tool) ?? 0;
          return { tool: parseMcpTool(tool)?.tool ?? tool, count };
        })
        .sort((a, b) => b.count - a.count);
      return { server: s.server, calls: s.calls, approxResultTokens, topTools };
    })
    .sort((a, b) => b.calls - a.calls);
  return { byMcpServer };
}

/** GET /api/tools/heaviest-results — the 15 tools whose results dumped the most tokens into context. */
export function buildHeaviestResults(toolResultStats: ToolResultRow[]): HeaviestResultsResponse {
  const heaviestToolResults = toolResultStats
    .map((r) => ({ tool: r.tool, count: r.count, approxTokens: r.approxTokens }))
    .sort((a, b) => b.approxTokens - a.approxTokens)
    .slice(0, 15);
  return { heaviestToolResults };
}
