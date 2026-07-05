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

/** GET /api/usage/by-source — tokens/cost per source with its distinct-session count. */
export function buildUsageBySource(
  rows: BySourceModel[],
  sessionsBySource: Array<{ source: string; sessions: number }>,
): UsageBySourceResponse {
  const sessions = new Map(sessionsBySource.map((r) => [r.source, r.sessions]));
  const bySource: NamedUsage[] = [...foldUsageByKey(rows, (r) => r.source).entries()]
    .map(([name, v]) => ({
      name,
      messages: v.messages,
      total: totalTokens(v.u),
      cost: v.cost,
      meta: { sessions: sessions.get(name) ?? 0 },
    }))
    .sort((a, b) => b.total - a.total);
  return { bySource };
}

/** GET /api/usage/by-project — tokens/cost per project with its distinct-session count. (Per-project
 *  friction lives on GET /api/health, not here — the Projects view doesn't read it.) */
export function buildUsageByProject(
  rows: ByProjectModel[],
  sessionsByProject: Array<{ project: string; sessions: number }>,
): UsageByProjectResponse {
  const sessions = new Map(sessionsByProject.map((r) => [r.project, r.sessions]));
  const byProject: NamedUsage[] = [...foldUsageByKey(rows, (r) => r.project).entries()]
    .map(([name, v]) => ({
      name,
      messages: v.messages,
      total: totalTokens(v.u),
      cost: v.cost,
      meta: { sessions: sessions.get(name) ?? 0 },
    }))
    .sort((a, b) => b.total - a.total);
  return { byProject };
}
