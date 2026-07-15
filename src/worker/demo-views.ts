// Read-only view wiring for the Cloudflare Worker demo (#281 Part B.4) — a scoped-down twin of
// startServer's view wiring (src/api/serve.ts). Deliberately NOT shared code with startServer: that
// function is built around per-request `openStore()`/`withWriteStore()` (a fresh bun:sqlite connection
// per call, since the CLI's store lives in a file another process might also be writing) and Node-only
// concerns (argus.json, the secret store, resolveClaudeBinary's spawnSync) that have no DO equivalent.
// The DO's store is a single connection, opened once and held open by ArgusDemoStore for the object's
// whole lifetime — there is no writable/read-only split to make here, and demo mode drops every write
// route in createApp before these would ever run. `labels`'s write methods still have to exist (LabelOps
// has no read-only variant) but are unreachable in demo mode; they throw defensively rather than
// silently no-op, so a future wiring mistake fails loudly instead of pretending to succeed.
import { sourcesFor } from "../reporting/dashboard-builder.ts";
import { buildPluginInventory } from "../reporting/inventory.ts";
import { unpricedModels } from "../pricing.ts";
import type { ResolvedQuery, SessionSearchMatch, Store } from "../store/store-contract.ts";
import type { PluginInfo, PluginRow } from "../types.ts";
import {
  buildUsageByModel,
  buildUsageByProject,
  buildUsageBySource,
  buildUsageDaily,
} from "../api/usage.ts";
import {
  buildByMcpServer,
  buildByTool,
  buildByToolCategory,
  buildHeaviestResults,
  buildSkills,
  foldBySkill,
} from "../api/tools.ts";
import { buildPlugins } from "../api/plugins.ts";
import { buildHealth } from "../api/health.ts";
import { buildSessionDetail, buildSessionList } from "../api/session-list.ts";
import { computeRecommendations } from "../api/recommendations.ts";
import { computeTaskMetrics, type TaskMetrics } from "../api/task-metrics.ts";
import { buildSessionInteractions } from "../api/session-interactions.ts";
import type {
  LabelOps,
  SessionDetailReader,
  SessionInteractionsReader,
  SessionListReader,
  SessionProvenanceReader,
  SessionTaskMetricsReader,
  SnapshotFilters,
  ViewReaders,
} from "../api/serve.ts";

const notAvailableInDemo = (): never => {
  throw new Error("Writes aren't available in the read-only demo.");
};

/** Every filter defaults to "show the whole seeded corpus" — the demo has no CLI flags to fall back
 *  to, and the corpus is small and fixed (nightly-reseeded), so there's no baseline to narrow from. */
function queryFor(filters: SnapshotFilters): ResolvedQuery {
  return {
    sources: sourcesFor(filters.source ?? "all"),
    since: filters.since,
    until: filters.until,
    projectSubstring: filters.project,
  };
}

const withStore = async <T>(
  store: Store,
  filters: SnapshotFilters,
  fn: (store: Store, query: ResolvedQuery) => Promise<T>,
): Promise<T> => fn(store, queryFor(filters));

/** Shared by the /api/plugins view and the unused-plugins recommendation (mirrors startServer's
 *  byPluginFor) so the two can't drift for the same filters. `plugins` is resolved once per DO open
 *  (below), not read from disk per call — there is no disk here (#281 Part B.3). */
async function byPluginFor(
  store: Store,
  query: ResolvedQuery,
  plugins: Map<string, PluginInfo>,
): Promise<PluginRow[]> {
  const [skillRows, mcpServers] = await Promise.all([
    store.readUsageBySkillModel(query),
    store.readMcpServers(query),
  ]);
  return buildPlugins(foldBySkill(skillRows, plugins), mcpServers, plugins).byPlugin;
}

export interface DemoViews {
  views: ViewReaders;
  sessionTaskMetrics: SessionTaskMetricsReader;
  sessionList: SessionListReader;
  sessionDetail: SessionDetailReader;
  sessionInteractions: SessionInteractionsReader;
  sessionProvenance: SessionProvenanceReader;
  labels: LabelOps;
}

export async function buildDemoViews(store: Store): Promise<DemoViews> {
  // Resolved once per DO open, not per request — there's no disk to re-read from here (#281 Part
  // B.3), and the seeded inventory only changes when `/admin/seed` runs (which reopens the DO's
  // in-memory app state along with everything else it wipes and replays).
  const inventoryJson = await store.getPluginInventoryJson();
  const plugins = buildPluginInventory(inventoryJson?.settingsJson, inventoryJson?.installedPluginsJson);

  const views: ViewReaders = {
    usageDaily: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [rows, sessions] = await Promise.all([
          store.readUsageByDateModel(query),
          store.readSessionsBySource(query),
        ]);
        return buildUsageDaily(rows, sessions.reduce((n, r) => n + r.sessions, 0));
      }),
    usageByModel: (filters) =>
      withStore(store, filters, async (store, query) => buildUsageByModel(await store.readUsageByDateModel(query))),
    usageBySource: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [rows, sessions] = await Promise.all([
          store.readUsageBySourceModel(query),
          store.readSessionsBySource(query),
        ]);
        return buildUsageBySource(rows, sessions);
      }),
    usageByProject: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [rows, sessions] = await Promise.all([
          store.readUsageByProjectModel(query),
          store.readSessionsByProject(query),
        ]);
        return buildUsageByProject(rows, sessions);
      }),
    skills: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [rows, byDate, dates] = await Promise.all([
          store.readUsageBySkillModel(query),
          store.readSkillTokensByDate(query),
          store.readActiveDates(query),
        ]);
        return buildSkills(rows, byDate, dates, plugins);
      }),
    toolsByTool: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [stats, results] = await Promise.all([store.readToolStats(query), store.readToolResultStats(query)]);
        return buildByTool(stats, results);
      }),
    toolsByCategory: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [categories, stats, results] = await Promise.all([
          store.readToolCategoryStats(query),
          store.readToolStats(query),
          store.readToolResultStats(query),
        ]);
        return buildByToolCategory(categories, stats, results);
      }),
    toolsByMcpServer: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [servers, serverTools, results] = await Promise.all([
          store.readMcpServers(query),
          store.readMcpServerTools(query),
          store.readToolResultStats(query),
        ]);
        return buildByMcpServer(servers, serverTools, results);
      }),
    toolsHeaviestResults: (filters) =>
      withStore(store, filters, async (store, query) => buildHeaviestResults(await store.readToolResultStats(query))),
    plugins: (filters) =>
      withStore(store, filters, async (store, query) => ({ byPlugin: await byPluginFor(store, query, plugins) })),
    health: (filters) =>
      withStore(store, filters, async (store, query) => buildHealth(await store.readHealthRollups(query))),
    recommendations: (filters) =>
      withStore(store, filters, async (store, query) => {
        const [byPlugin, health] = await Promise.all([
          byPluginFor(store, query, plugins),
          store.readHealthRollups(query),
        ]);
        return {
          recommendations: computeRecommendations({
            byPlugin,
            highTokenGrowthSessions: health.highTokenGrowthSessions,
            frictionTotals: health.frictionTotals,
            unpriced: unpricedModels(),
          }),
        };
      }),
  };

  const sessionTaskMetrics: SessionTaskMetricsReader = async (sessionId) => {
    const [byTask, interactionCounts] = await Promise.all([
      store.readSessionTaskMessages(sessionId),
      store.readSessionTaskInteractionCounts(sessionId),
    ]);
    const out: Record<string, TaskMetrics> = {};
    for (const [taskId, messages] of byTask) out[taskId] = computeTaskMetrics(messages);
    for (const [taskId, n] of interactionCounts) {
      const m = out[taskId] ?? (out[taskId] = computeTaskMetrics([]));
      m.interactions = n;
    }
    return out;
  };

  const sessionList: SessionListReader = async (query) => {
    const sources = sourcesFor(query.source ?? "all");
    const since = query.since;
    const until = query.until;
    let sessionIds: string[] | undefined;
    let matches: Map<string, SessionSearchMatch> | undefined;
    if (query.q || query.file) {
      const search = await store.searchSessions({ sources, since, until, text: query.q, file: query.file });
      sessionIds = [...search.ids];
      matches = search.matches;
    }
    if (query.label?.length) {
      const labeled = await store.readSessionIdsForLabels(query.label, query.labelMode ?? "any");
      sessionIds = sessionIds ? sessionIds.filter((id) => labeled.has(id)) : [...labeled];
    }
    const aggregates = await store.readSessionAggregates({ sources, since, until, sessionIds });
    const list = buildSessionList(aggregates, {
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
      project: query.project,
      q: matches ? undefined : query.q,
      includeGenerated: query.includeGenerated,
      matches,
    });
    const labelsBySession = await store.readSessionLabelsForSessions(list.rows.map((r) => r.sessionId));
    if (labelsBySession.size) {
      list.rows = list.rows.map((r) => {
        const labels = labelsBySession.get(r.sessionId);
        return labels && labels.length ? { ...r, labels } : r;
      });
    }
    return list;
  };

  const sessionDetail: SessionDetailReader = async (sessionId) => {
    const messages = await store.readSessionMessages(sessionId);
    if (!messages.length) return null;
    const [meta, tasks, interpretation, isHidden, interactions] = await Promise.all([
      store.readSessionMeta(sessionId),
      store.readSessionTasks(sessionId),
      store.readSessionInterpretation(sessionId),
      store.readSessionHidden(sessionId),
      store.readSessionInteractionCount(sessionId),
    ]);
    return buildSessionDetail(sessionId, messages, meta, tasks, interpretation, isHidden, interactions);
  };

  const sessionInteractions: SessionInteractionsReader = async (sessionId) => {
    const [interactions, invocations, messages, tasks] = await Promise.all([
      store.readSessionInteractions(sessionId),
      store.readSessionInvocations(sessionId),
      store.readSessionMessages(sessionId),
      store.readSessionTasks(sessionId),
    ]);
    if (!interactions.length) return null;
    return buildSessionInteractions(interactions, invocations, messages, tasks);
  };

  const sessionProvenance: SessionProvenanceReader = (sessionId) => store.readSessionProvenance(sessionId);

  const labels: LabelOps = {
    list: () => store.listLabels(),
    readForSession: (sessionId) => store.readSessionLabels(sessionId),
    readForSessions: (sessionIds) => store.readSessionLabelsForSessions(sessionIds),
    create: notAvailableInDemo,
    rename: notAvailableInDemo,
    remove: notAvailableInDemo,
    assign: notAvailableInDemo,
    unassign: notAvailableInDemo,
    setForSessions: notAvailableInDemo,
  };

  return { views, sessionTaskMetrics, sessionList, sessionDetail, sessionInteractions, sessionProvenance, labels };
}
