// Builds the analyzed Dashboard from local transcripts. Extracted from the CLI entry point so
// both `argus sync` and the local web server (src/serve.ts) — and, later, the argusd daemon —
// share one code path for reading + aggregating sessions.
import { aggregate } from "./aggregate.ts";
import type { Dashboard } from "./aggregate.ts";
import { assembleDashboard } from "./snapshot.ts";
import { loadPlugins } from "./inventory.ts";
import type { TranscriptSource } from "../types.ts";
import { readSnapshotAggregates, syncStatsSummary } from "../indexing/pipeline.ts";
import { openSessionStore } from "../store/session-store.ts";
import type { ParserDiagnostic } from "../store/store-contract.ts";
import { heuristicSummary, summaryFactsFromMessages } from "../indexing/interpret/summarize.ts";
import type { MessageRecord } from "../types.ts";

export type Log = (s: string) => void;

/** Inputs buildDashboard needs — a narrow slice of the CLI flags so non-CLI callers (serve, argusd)
 *  don't have to construct the whole Flags object. */
export interface BuildDashboardOptions {
  source: "all" | TranscriptSource;
  since?: string;
  until?: string;
  project?: string;
  /** Read the store without reconciling first (no writes). Set by the serve/upload legs of
   *  `argus run`, where the index leg is the sole writer; left false for one-shot commands. */
  readOnly?: boolean;
  /** Include the full per-session row array in the dashboard. Default true (sync needs it on the
   *  wire); the web server sets false and serves sessions from the paginated /api/sessions instead. */
  includeSessions?: boolean;
  /** Build for the team sync wire: drop local-only sources (claude.ai chat is personal usage with
   *  estimated, not metered, tokens — it stays in the local web app/reports only). Set by the sync
   *  upload path; left false for serve/index/reports, which show every source. */
  forWire?: boolean;
}

/** Every source Argus can index, in display order. */
export const ALL_SOURCES: TranscriptSource[] = ["claude", "codex", "gemini", "cowork", "claude-chat"];

/** Sources kept local-only — indexed and shown locally, but never uploaded by `sync`. */
export const LOCAL_ONLY_SOURCES: ReadonlySet<TranscriptSource> = new Set<TranscriptSource>(["claude-chat"]);

export function sourcesFor(
  source: "all" | TranscriptSource,
  opts: { forWire?: boolean } = {},
): TranscriptSource[] {
  const base = source === "all" ? ALL_SOURCES : [source];
  return opts.forWire ? base.filter((s) => !LOCAL_ONLY_SOURCES.has(s)) : base;
}

/** One-line totals for a built dashboard, shared by the sync upload path. */
export function summaryLine(dash: Dashboard): string {
  return (
    `${dash.totals.sessions} sessions · ${dash.totals.messages} msgs · ` +
    `${(dash.totals.total / 1e6).toFixed(2)}M tokens · $${dash.totals.cost.toFixed(2)} est.`
  );
}

function diagnosticKey(entry: ParserDiagnostic): string {
  return `${entry.severity}\0${entry.code}\0${entry.message}`;
}

function uniqueDiagnostics(entries: ParserDiagnostic[]): ParserDiagnostic[] {
  const seen = new Set<string>();
  const out: ParserDiagnostic[] = [];
  for (const entry of entries) {
    const key = diagnosticKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** Diagnostics worth interrupting a report for: something that makes the result wrong or incomplete.
 *  A missing source root just means the user doesn't use that tool — not a problem to report.
 *  Routine notes (re-read files) are left for `argus sync`. */
function reportProblems(diagnostics: ParserDiagnostic[]): ParserDiagnostic[] {
  return uniqueDiagnostics(diagnostics)
    .filter((entry) => entry.severity === "error" && entry.code !== "missing_root")
    .slice(0, 5);
}

/** Parse transcripts, apply filters, summarize heuristically, and build the aggregate dashboard. */
export async function buildDashboard(opts: BuildDashboardOptions, log: Log): Promise<Dashboard> {
  log("Reading transcripts…");
  const store = openSessionStore({
    sources: sourcesFor(opts.source, { forWire: opts.forWire }),
  });
  // CQS: read-only legs (serve/upload of `argus run`, where the index leg writes) do a pure read;
  // otherwise (e.g. one-shot `argus sync`) bring the store current first, then read.
  const query = { since: opts.since, until: opts.until, projectSubstring: opts.project };
  let parseResult;
  try {
    parseResult = opts.readOnly ? await store.read(query) : await store.index(query);
  } finally {
    await store.close();
  }
  // Keep reports quiet: only call out problems that affect the result (and explain a degraded read).
  if (store.stats?.fallback) log(`  ${syncStatsSummary(store.stats)}`);
  for (const entry of reportProblems(store.diagnostics)) log(`  ! ${entry.message}`);

  log(`  ${parseResult.messages.length} assistant messages across ${parseResult.sessions.size} sessions.`);

  const plugins = loadPlugins();

  // A heuristic one-line summary per session, from the same fact derivation /api/session/:id uses.
  const messagesBySession = new Map<string, MessageRecord[]>();
  for (const m of parseResult.messages) {
    (messagesBySession.get(m.sessionId) ?? messagesBySession.set(m.sessionId, []).get(m.sessionId)!).push(m);
  }
  const summaries = new Map<string, string>();
  for (const [sid, msgs] of messagesBySession) {
    const firstPrompt = parseResult.sessions.get(sid)?.firstPrompt || "";
    summaries.set(sid, heuristicSummary(summaryFactsFromMessages(msgs, firstPrompt)));
  }

  const dash = aggregate(parseResult, plugins, summaries, { includeSessions: opts.includeSessions });
  dash.generatedAtMs = Date.now();
  return dash;
}

/**
 * Build the serve snapshot from SQL `GROUP BY` rollups (#121) — the dashboard without materializing
 * every per-turn usage row. Always a pure read (no sync; serve's index leg is the sole writer) and
 * always omits per-session rows (the web app reads them from /api/sessions), so it needs no plugin
 * summaries. The numbers match the JS `aggregate()` for the breakdowns the serve UI consumes; cost is
 * priced per-model in JS exactly as before. The `sync` upload path still uses `buildDashboard`.
 */
export async function buildSnapshot(opts: BuildDashboardOptions, log: Log): Promise<Dashboard> {
  log("Reading transcripts…");
  const { aggregates, stats, diagnostics } = await readSnapshotAggregates({
    sources: sourcesFor(opts.source, { forWire: opts.forWire }),
    query: { since: opts.since, until: opts.until, projectSubstring: opts.project },
  });
  if (stats.fallback) log(`  ${syncStatsSummary(stats)}`);
  for (const entry of reportProblems(diagnostics)) log(`  ! ${entry.message}`);

  const dash = assembleDashboard(aggregates, loadPlugins());
  dash.generatedAtMs = Date.now();
  return dash;
}
