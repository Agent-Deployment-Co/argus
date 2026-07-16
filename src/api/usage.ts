// Serve-only builders for the usage breakdowns (#217). Each turns the store's pre-grouped
// per-(dimension, model) rows into the shape one view reads, pricing per model in JS (pricing is
// linear, so SUM-then-price equals price-then-SUM). Pure functions — no DB, no clock — so they're
// unit-testable against fixture rows. Replaces the daily/byModel/bySource/byProject slices the old
// monolithic assembleDashboard produced.
import { cost, unpricedModels } from "../pricing.ts";
import type { UsageGroupRow } from "../store/store-contract.ts";
import {
  addUsage,
  type Dashboard,
  type DayBucket,
  emptyUsage,
  type NamedUsage,
  totalTokens,
  type Usage,
} from "../types.ts";

type ByDateModel = { date: string } & UsageGroupRow;
type BySourceModel = { source: string } & UsageGroupRow;
type ByProjectModel = { project: string } & UsageGroupRow;

export interface UsageDailyResponse {
  totals: Dashboard["totals"];
  daily: Dashboard["daily"];
  unpriced: string[];
}

export interface UsageByModelResponse {
  byModel: NamedUsage[];
  byModelDaily: Dashboard["byModelDaily"];
}

export interface UsageBySourceResponse {
  bySource: NamedUsage[];
}

export interface UsageByProjectResponse {
  byProject: NamedUsage[];
}

export interface UsageBySourceDailyResponse {
  /** Sources in scope, ordered by total tokens descending — the stack + legend order. */
  sources: string[];
  /** One entry per active day (ascending), each with source→tokens and source→cost maps. */
  daily: { date: string; tokens: Record<string, number>; cost: Record<string, number> }[];
  /** Per-source period totals (the legend sums), keyed by source. */
  totalsBySource: Record<string, { tokens: number; cost: number }>;
  /** Grand totals over the whole period — the panel title values. */
  totalTokens: number;
  totalCost: number;
}

export interface DailyActivityDay {
  date: string;
  sessions: number;
  tokens: number;
  interactions: number;
}

export interface DailyActivityResponse {
  /** One entry per active day (ascending) with total sessions/tokens/interactions for that day. */
  days: DailyActivityDay[];
}

export interface SessionsBySourceResponse {
  /** Sources present in scope, ordered by total sessions descending — the stack/legend order. */
  sources: string[];
  /** One entry per active day (ascending), each with a source→session-count map. */
  daily: { date: string; bySource: Record<string, number> }[];
}

/** Fold (dimension, model) usage rows by an arbitrary key, summing usage/messages and pricing each
 *  row by its own model. Shared by the source/project/skill builders. */
export function foldUsageByKey<R extends { model: string; usage: Usage; messages: number }>(
  rows: R[],
  keyOf: (row: R) => string,
): Map<string, { u: Usage; messages: number; cost: number }> {
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
}

/** Fold (dimension, model) rows into sorted `NamedUsage[]` (per-model pricing, total-tokens desc),
 *  optionally attaching per-row `meta`. The one place the `NamedUsage` shape + sort lives — used by
 *  the by-source / by-project builders and by `foldBySkill` in tools.ts. */
export function foldNamedUsage<R extends { model: string; usage: Usage; messages: number }>(
  rows: R[],
  keyOf: (row: R) => string,
  metaFor?: (name: string) => NamedUsage["meta"],
): NamedUsage[] {
  return [...foldUsageByKey(rows, keyOf).entries()]
    .map(([name, v]) => {
      const row: NamedUsage = { name, messages: v.messages, total: totalTokens(v.u), cost: v.cost };
      const meta = metaFor?.(name);
      if (meta) row.meta = meta;
      return row;
    })
    .sort((a, b) => b.total - a.total);
}

/** GET /api/usage/daily — per-day token/cost buckets + grand totals + the unpriced-model list. Session
 *  count comes in separately (each session has one source, so it's the sum of the per-source counts). */
export function buildUsageDaily(rows: ByDateModel[], totalSessions: number): UsageDailyResponse {
  const dayMap = new Map<string, DayBucket>();
  const totalUsage = emptyUsage();
  let totalCost = 0;
  let totalMessages = 0;
  for (const r of rows) {
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
    addUsage(totalUsage, r.usage);
    totalCost += c;
    totalMessages += r.messages;
  }
  const daily = [...dayMap.keys()].sort().map((d) => dayMap.get(d)!);
  return {
    totals: {
      sessions: totalSessions,
      messages: totalMessages,
      usage: totalUsage,
      total: totalTokens(totalUsage),
      cost: totalCost,
    },
    // unpricedModels() reflects every model priced so far this process; folding daily above prices all
    // of them, so the Activity note is complete when this endpoint's own build ran.
    unpriced: unpricedModels(),
    daily,
  };
}

/** GET /api/usage/by-model — per-model totals + the per-day stacked series, from the same rows. */
export function buildUsageByModel(rows: ByDateModel[]): UsageByModelResponse {
  const modelMap = new Map<string, { u: Usage; messages: number; cost: number }>();
  const modelDayMap = new Map<string, Map<string, number>>();
  const dates = new Set<string>();
  for (const r of rows) {
    dates.add(r.date);
    const c = cost(r.usage, r.model);
    const md = modelMap.get(r.model) ?? { u: emptyUsage(), messages: 0, cost: 0 };
    addUsage(md.u, r.usage);
    md.messages += r.messages;
    md.cost += c;
    modelMap.set(r.model, md);

    let mdRow = modelDayMap.get(r.date);
    if (!mdRow) {
      mdRow = new Map();
      modelDayMap.set(r.date, mdRow);
    }
    mdRow.set(r.model, (mdRow.get(r.model) ?? 0) + totalTokens(r.usage));
  }
  const byModel: NamedUsage[] = [...modelMap.entries()]
    .map(([name, v]) => ({ name, messages: v.messages, total: totalTokens(v.u), cost: v.cost }))
    .sort((a, b) => b.total - a.total);
  const byModelDaily = [...dates]
    .sort()
    .map((d) => ({ date: d, byModel: Object.fromEntries(modelDayMap.get(d) ?? []) }));
  return { byModel, byModelDaily };
}

/** GET /api/usage/daily-activity — per-day totals for the Home daily-activity panel. Merges the
 *  per-day session/token rows (from resolved_usage) with the per-day interaction counts (bucketed
 *  from resolved_interactions), keyed by date. */
export function buildDailyActivity(
  usage: Array<{ date: string; sessions: number; tokens: number }>,
  interactions: Array<{ date: string; interactions: number }>,
): DailyActivityResponse {
  const map = new Map<string, DailyActivityDay>();
  for (const r of usage) map.set(r.date, { date: r.date, sessions: r.sessions, tokens: r.tokens, interactions: 0 });
  for (const r of interactions) {
    const day = map.get(r.date) ?? { date: r.date, sessions: 0, tokens: 0, interactions: 0 };
    day.interactions = r.interactions;
    map.set(r.date, day);
  }
  return { days: [...map.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

/** Fold per-(date, source) session counts into a daily series plus the source list (ordered by total
 *  sessions desc), for the sessions-by-source-by-day stacked column chart. */
export function buildSessionsBySource(
  rows: Array<{ date: string; source: string; sessions: number }>,
): SessionsBySourceResponse {
  const dates = new Set<string>();
  const dayMap = new Map<string, Map<string, number>>();
  const sourceTotals = new Map<string, number>();
  for (const r of rows) {
    dates.add(r.date);
    let day = dayMap.get(r.date);
    if (!day) {
      day = new Map();
      dayMap.set(r.date, day);
    }
    day.set(r.source, (day.get(r.source) ?? 0) + r.sessions);
    sourceTotals.set(r.source, (sourceTotals.get(r.source) ?? 0) + r.sessions);
  }
  const sources = [...sourceTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([s]) => s);
  const daily = [...dates]
    .sort()
    .map((d) => ({ date: d, bySource: Object.fromEntries(dayMap.get(d) ?? []) }));
  return { sources, daily };
}

/** GET /api/usage/by-source-daily — the per-day, per-source token/cost series behind the Home usage
 *  hero (stacked columns, one series per source, switchable tokens/cost). Prices each (date, source,
 *  model) row by its own model, so cost is exact per source and per day. Sources are ordered by total
 *  tokens desc (the stack/legend order); the same ordering drives cost mode so the two modes stay
 *  visually aligned. */
export function buildUsageBySourceDaily(
  rows: Array<{ date: string; source: string } & UsageGroupRow>,
): UsageBySourceDailyResponse {
  const dates = new Set<string>();
  const dayTokens = new Map<string, Map<string, number>>();
  const dayCost = new Map<string, Map<string, number>>();
  const totals = new Map<string, { tokens: number; cost: number }>();
  let totalTokensAll = 0;
  let totalCostAll = 0;
  for (const r of rows) {
    dates.add(r.date);
    const tok = totalTokens(r.usage);
    const c = cost(r.usage, r.model);

    const tokRow = dayTokens.get(r.date) ?? new Map<string, number>();
    tokRow.set(r.source, (tokRow.get(r.source) ?? 0) + tok);
    dayTokens.set(r.date, tokRow);
    const costRow = dayCost.get(r.date) ?? new Map<string, number>();
    costRow.set(r.source, (costRow.get(r.source) ?? 0) + c);
    dayCost.set(r.date, costRow);

    const t = totals.get(r.source) ?? { tokens: 0, cost: 0 };
    t.tokens += tok;
    t.cost += c;
    totals.set(r.source, t);
    totalTokensAll += tok;
    totalCostAll += c;
  }
  const sources = [...totals.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0]))
    .map(([s]) => s);
  const daily = [...dates].sort().map((d) => ({
    date: d,
    tokens: Object.fromEntries(dayTokens.get(d) ?? []),
    cost: Object.fromEntries(dayCost.get(d) ?? []),
  }));
  return {
    sources,
    daily,
    totalsBySource: Object.fromEntries(totals),
    totalTokens: totalTokensAll,
    totalCost: totalCostAll,
  };
}

/** GET /api/usage/by-source — tokens/cost per source with its distinct-session count. */
export function buildUsageBySource(
  rows: BySourceModel[],
  sessionsBySource: Array<{ source: string; sessions: number }>,
  interactionsBySource: Array<{ source: string; n: number }> = [],
  tasksBySource: Array<{ source: string; n: number }> = [],
): UsageBySourceResponse {
  const sessions = new Map(sessionsBySource.map((r) => [r.source, r.sessions]));
  const interactions = new Map(interactionsBySource.map((r) => [r.source, r.n]));
  const tasks = new Map(tasksBySource.map((r) => [r.source, r.n]));
  return {
    bySource: foldNamedUsage(rows, (r) => r.source, (name) => ({
      sessions: sessions.get(name) ?? 0,
      interactions: interactions.get(name) ?? 0,
      tasks: tasks.get(name) ?? 0,
    })),
  };
}

/** GET /api/usage/by-project — tokens/cost per project with its distinct-session count. (Per-project
 *  friction lives on GET /api/health, not here — the Projects view doesn't read it.) */
export function buildUsageByProject(
  rows: ByProjectModel[],
  sessionsByProject: Array<{ project: string; sessions: number }>,
): UsageByProjectResponse {
  const sessions = new Map(sessionsByProject.map((r) => [r.project, r.sessions]));
  return { byProject: foldNamedUsage(rows, (r) => r.project, (name) => ({ sessions: sessions.get(name) ?? 0 })) };
}
