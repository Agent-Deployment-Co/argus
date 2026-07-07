// Serve-side shaping for the paginated session resource (/api/sessions, /api/session/:id). The store
// hands back cheap per-session token rollups (SessionAggregate); here we price them (the price table
// lives in JS), apply the list-level refinements that don't belong in SQL (project label match,
// free-text, Argus-generated toggle), sort, and slice a page. Detail builds a full SessionRow on
// demand from one session's messages. These response shapes are local-only (not on the sync wire).
import { buildSessionRow } from "../reporting/aggregate.ts";
import { cost } from "../pricing.ts";
import type { SessionAggregate, SessionSearchMatch, TaskFact } from "../store/store-contract.ts";
import { heuristicSummary, summaryFactsFromMessages } from "../indexing/interpret/summarize.ts";
import { totalTokens, type AgentSource, type MessageRecord, type SessionMeta, type SessionRow } from "../types.ts";

export type SessionSort = "recent" | "tokens" | "cost";

/** A lightweight session row for the list — enough to render and rank, without the heavy per-session
 *  content (tool/skill breakdowns, files, health, tasks) that only the detail view needs. */
export interface SessionListItem {
  sessionId: string;
  source: AgentSource;
  project: string;
  firstPrompt: string | null;
  /** The model-generated title when the session has been interpreted (#234), else null — the UI falls
   *  back to `firstPrompt`. */
  title: string | null;
  /** The model-generated one-line summary when interpreted (#234), else null. */
  summary: string | null;
  start: number;
  end: number;
  userMessages: number | null;
  agentMessages: number | null;
  total: number;
  cost: number;
  /** Present when a store-side search ran (#155) and this session matched an FTS table — the
   *  conversation/task-text snippet + count the UI highlights. Absent for a metadata-only match
   *  (title/project/source substring, or a bare `file:` search). Local-only, not on the sync wire. */
  match?: SessionSearchMatch;
}

export interface SessionListResponse {
  rows: SessionListItem[];
  /** Matches after filtering, before pagination — so the UI can show "showing N of total". */
  total: number;
  offset: number;
  limit: number;
}

export interface SessionListParams {
  sort: SessionSort;
  limit: number;
  offset: number;
  /** Substring match on the human project label (not the cwd the store filters on). */
  project?: string;
  /** Free-text over the session title / project / source. Omit when the caller already ran a
   *  store-side search (`matches` is set) — the store's metadata-OR-FTS logic already applied it,
   *  and re-running this plain substring check would wrongly drop an FTS-only match. */
  q?: string;
  /** Include Argus's own task-extraction/analysis sessions (hidden by default). */
  includeGenerated?: boolean;
  /** Per-session search match (#155), when the caller ran `store.searchSessions` first. Attached onto
   *  the matching rows; sessions with no entry here had a metadata-only match (or no search ran). */
  matches?: Map<string, SessionSearchMatch>;
}

/** Argus's own `claude -p` runs surface as sessions; recognize them by their canned first prompts so
 *  the list can hide them by default. Keep in sync with the web's isArgusGeneratedSession. */
export function isArgusGeneratedSession(firstPrompt: string | null | undefined): boolean {
  const title = firstPrompt?.trim();
  return Boolean(
    title === "Task extraction run" ||
      title === "Session analysis run" ||
      title?.startsWith("Task extraction for ") ||
      title?.startsWith("Session analysis for "),
  );
}

function listItem(agg: SessionAggregate): SessionListItem {
  let total = 0;
  let c = 0;
  for (const { model, usage } of agg.byModel) {
    total += totalTokens(usage);
    c += cost(usage, model);
  }
  const meta = agg.meta;
  return {
    sessionId: meta.sessionId,
    source: meta.source,
    project: meta.project,
    firstPrompt: meta.firstPrompt ?? null,
    title: agg.title ?? null,
    summary: agg.summary ?? null,
    start: agg.firstTs ?? 0,
    end: agg.lastTs ?? 0,
    userMessages: meta.userMessages ?? null,
    agentMessages: meta.agentMessages ?? null,
    total,
    cost: c,
  };
}

const SORTERS: Record<SessionSort, (a: SessionListItem, b: SessionListItem) => number> = {
  recent: (a, b) => b.start - a.start,
  tokens: (a, b) => b.total - a.total,
  cost: (a, b) => b.cost - a.cost,
};

/** Shape store aggregates into a sorted, filtered, paginated page of list rows. Source/date/project-by-
 *  cwd filtering already happened in SQL; here we price cost, apply the label/text/generated refines
 *  (which the list does over the human-facing fields), sort, and slice. */
export function buildSessionList(aggregates: SessionAggregate[], params: SessionListParams): SessionListResponse {
  const project = params.project?.toLowerCase();
  const term = params.q?.trim().toLowerCase();
  let items = aggregates.map(listItem);
  if (params.matches) {
    items = items.map((it) => {
      const match = params.matches!.get(it.sessionId);
      return match ? { ...it, match } : it;
    });
  }
  items = items.filter((it) => {
    if (!params.includeGenerated && isArgusGeneratedSession(it.firstPrompt)) return false;
    if (project && !it.project.toLowerCase().includes(project)) return false;
    if (term) {
      // Match the model title (when present), the first prompt, the project, and the source.
      const title = `${it.title ?? ""} ${it.firstPrompt ?? ""}`.toLowerCase();
      if (!title.includes(term) && !it.project.toLowerCase().includes(term) && !it.source.toLowerCase().includes(term)) {
        return false;
      }
    }
    return true;
  });
  items.sort(SORTERS[params.sort]);
  const total = items.length;
  const offset = Math.max(0, params.offset);
  const rows = items.slice(offset, offset + params.limit);
  return { rows, total, offset, limit: params.limit };
}

/** Build the full detail row for one session from its messages (oldest first) — the same SessionRow
 *  the dashboard would produce, computed on demand so heavy per-session content never rides the bulk
 *  payload. Prefers the model-generated title/summary when the session has been interpreted (#234),
 *  falling back to the first prompt / heuristic summary so an un-interpreted session doesn't regress.
 *  The heuristic summary uses the shared `summaryFactsFromMessages` so it matches the dashboard. */
export function buildSessionDetail(
  sessionId: string,
  messages: MessageRecord[],
  meta: SessionMeta | undefined,
  tasks: TaskFact[],
  interpretation?: { title: string | null; summary: string | null; interpreted: boolean },
): SessionRow {
  const summary =
    interpretation?.summary ||
    heuristicSummary(summaryFactsFromMessages(messages, meta?.firstPrompt || ""));
  const title = interpretation?.title || null;
  return buildSessionRow(sessionId, messages, meta, summary, tasks, title, interpretation?.interpreted ?? false);
}
