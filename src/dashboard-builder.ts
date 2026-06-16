// Builds the analyzed Dashboard from local transcripts. Extracted from the CLI entry point so
// both `argus report`/`push` (src/index.ts) and the local web server (src/serve.ts) — and, later,
// the argusd daemon — share one code path for reading + aggregating sessions.
import { aggregate } from "./aggregate.ts";
import type { Dashboard } from "./aggregate.ts";
import { loadPlugins } from "./inventory.ts";
import type { TranscriptSource } from "./parse.ts";
import { syncStatsSummary } from "./parse-incremental.ts";
import { openSessionStore } from "./session-store.ts";
import type { ParserDiagnostic } from "./store-contract.ts";
import { claudeAvailable, heuristicSummary, llmSummaries } from "./summarize.ts";
import type { SessionMeta } from "./types.ts";

export type Log = (s: string) => void;

/** Inputs buildDashboard needs — a narrow slice of the CLI flags so non-CLI callers (serve, argusd)
 *  don't have to construct the whole Flags object. */
export interface BuildDashboardOptions {
  source: "all" | TranscriptSource;
  agentsView: "auto" | "off";
  agentsViewDatabasePath?: string;
  since?: string;
  until?: string;
  project?: string;
  summarize: boolean;
  summarizeModel?: string;
}

export function sourcesFor(source: "all" | TranscriptSource): TranscriptSource[] {
  return source === "all" ? ["claude", "codex", "gemini", "cowork"] : [source];
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
 *  Routine notes (re-read files, AgentsView provenance) are left for `argus sync`. */
function reportProblems(diagnostics: ParserDiagnostic[]): ParserDiagnostic[] {
  return uniqueDiagnostics(diagnostics)
    .filter((entry) => entry.severity === "error" && entry.code !== "missing_root")
    .slice(0, 5);
}

/** Parse transcripts, apply filters, summarize, and build the aggregate dashboard. */
export async function buildDashboard(opts: BuildDashboardOptions, log: Log): Promise<Dashboard> {
  log("Reading transcripts…");
  const store = openSessionStore({
    sources: sourcesFor(opts.source),
    agentsView: opts.agentsView,
    agentsViewDatabasePath: opts.agentsViewDatabasePath,
  });
  let parseResult;
  try {
    parseResult = await store.read({
      since: opts.since,
      until: opts.until,
      projectSubstring: opts.project,
    });
  } finally {
    await store.close();
  }
  // Keep reports quiet: only call out problems that affect the result (and explain a degraded read).
  if (store.stats?.fallback) log(`  ${syncStatsSummary(store.stats, store.diagnostics)}`);
  for (const entry of reportProblems(store.diagnostics)) log(`  ! ${entry.message}`);

  log(`  ${parseResult.messages.length} assistant messages across ${parseResult.sessions.size} sessions.`);

  const plugins = loadPlugins();

  // Build per-session last-timestamp + heuristic summaries first.
  const lastTs = new Map<string, number>();
  const factsBySession = new Map<string, { firstPrompt: string; topSkills: string[]; toolCounts: Record<string, number>; filesTouched: string[] }>();
  for (const m of parseResult.messages) {
    lastTs.set(m.sessionId, Math.max(lastTs.get(m.sessionId) || 0, m.ts));
    const f = factsBySession.get(m.sessionId) || {
      firstPrompt: parseResult.sessions.get(m.sessionId)?.firstPrompt || "",
      topSkills: [],
      toolCounts: {},
      filesTouched: [],
    };
    if (m.attributionSkill && !f.topSkills.includes(m.attributionSkill)) f.topSkills.push(m.attributionSkill);
    for (const tu of m.toolUses) {
      f.toolCounts[tu.name] = (f.toolCounts[tu.name] || 0) + 1;
      if (tu.filePath && !f.filesTouched.includes(tu.filePath)) f.filesTouched.push(tu.filePath);
    }
    factsBySession.set(m.sessionId, f);
  }

  const summaries = new Map<string, string>();

  if (opts.summarize) {
    if (!claudeAvailable()) {
      log("  ! 'claude' CLI not found on PATH — falling back to heuristic summaries.");
    } else {
      log(`Summarizing ${parseResult.sessions.size} sessions via claude -p (cached; incremental)…`);
      const targets: { meta: SessionMeta; lastTs: number }[] = [];
      for (const meta of parseResult.sessions.values()) {
        targets.push({ meta, lastTs: lastTs.get(meta.sessionId) || 0 });
      }
      const llm = llmSummaries(targets, opts.summarizeModel, log);
      for (const [sid, s] of llm) summaries.set(sid, s);
    }
  }

  // Fill any missing summaries with the heuristic.
  for (const [sid, f] of factsBySession) {
    if (!summaries.has(sid)) summaries.set(sid, heuristicSummary(f));
  }

  const dash = aggregate(parseResult, plugins, summaries);
  dash.generatedAtMs = Date.now();
  return dash;
}
