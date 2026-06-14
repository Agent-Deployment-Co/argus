// The SessionStore is the stable seam between data collection and everything downstream
// (analysis + reporting). Collection produces a `ParseResult` reconciled from whatever sources
// are configured; consumers query it through `read()` without knowing whether the facts came
// from the fragment cache, an uncached parse, or (Phase 1b) materialized SQLite rows.
//
// Phase 1a: thin wrappers over the existing parse paths so behavior is unchanged. The richer
// query methods (listSessions/getSession/messagesForSession) and SQL-backed reads land in
// later steps; the interface intentionally leaves room for them.
import type { ParserDiagnostic } from "./store-contract.ts";
import {
  parseAllIncrementalDetailed,
  type IncrementalCacheStats,
} from "./parse-incremental.ts";
import { parseAll, type TranscriptSource } from "./parse.ts";
import type { AgentSource, ParseResult } from "./types.ts";

/** Filters applied to a collected `ParseResult` at read time. */
export interface SessionQuery {
  /** Restrict to these agent sources. Omit for all collected sources. */
  sources?: AgentSource[];
  /** Inclusive lower bound on message local date (YYYY-MM-DD). */
  since?: string;
  /** Inclusive upper bound on message local date (YYYY-MM-DD). */
  until?: string;
  /** Keep only sessions whose cwd contains this substring. */
  projectSubstring?: string;
}

/** Collection-time configuration: which sources to gather and how. */
export interface SessionStoreOptions {
  /** Sources to collect. Omit to use the parse defaults. */
  sources?: TranscriptSource[];
  /** Use the fragment cache (default) or parse directly when false. */
  cache?: boolean;
  /** Override the fragment cache path. */
  cachePath?: string;
  /** AgentsView import behavior (cached path only). */
  agentsView?: "auto" | "off";
  /** Read a specific AgentsView sessions.db (cached path only). */
  agentsViewDatabasePath?: string;
}

export interface SessionStore {
  /** Reconcile collected facts into a `ParseResult`, optionally filtered. */
  read(query?: SessionQuery): Promise<ParseResult>;
  /** Cache stats from the most recent read (undefined for the uncached store). */
  readonly stats?: IncrementalCacheStats;
  /** Collection diagnostics from the most recent read. */
  readonly diagnostics: ParserDiagnostic[];
  close(): Promise<void>;
}

function withinRange(date: string, since?: string, until?: string): boolean {
  if (since && date < since) return false;
  if (until && date > until) return false;
  return true;
}

/**
 * Apply a `SessionQuery` to a `ParseResult` in place: drop non-matching messages, then drop
 * sessions left with no surviving messages. A no-op (sessions with zero messages are kept) when
 * the query carries no filters — matching the pre-store behavior in index.ts.
 */
export function applySessionQuery(parsed: ParseResult, query?: SessionQuery): ParseResult {
  if (!query) return parsed;
  const { sources, since, until, projectSubstring } = query;
  if (!sources && !since && !until && !projectSubstring) return parsed;
  const sourceSet = sources ? new Set<AgentSource>(sources) : undefined;
  parsed.messages = parsed.messages.filter(
    (m) =>
      (!sourceSet || sourceSet.has(m.source)) &&
      withinRange(m.date, since, until) &&
      (!projectSubstring || m.cwd.includes(projectSubstring)),
  );
  const keep = new Set(parsed.messages.map((m) => m.sessionId));
  for (const sid of [...parsed.sessions.keys()]) {
    if (!keep.has(sid)) parsed.sessions.delete(sid);
  }
  return parsed;
}

/** Backed by the incremental fragment cache (the default collection path). */
class FragmentBackedSessionStore implements SessionStore {
  stats?: IncrementalCacheStats;
  diagnostics: ParserDiagnostic[] = [];

  constructor(private readonly opts: SessionStoreOptions) {}

  async read(query?: SessionQuery): Promise<ParseResult> {
    // Filters are pushed down to the materialized read model (SQL WHERE), so the reader never
    // reconciles or post-filters in memory.
    const details = await parseAllIncrementalDetailed({
      sources: this.opts.sources,
      cachePath: this.opts.cachePath,
      agentsView: this.opts.agentsView,
      agentsViewDatabasePath: this.opts.agentsViewDatabasePath,
      query,
    });
    this.stats = details.stats;
    this.diagnostics = details.diagnostics;
    return details.parsed;
  }

  async close(): Promise<void> {
    // parseAllIncrementalDetailed owns and closes its own cache handle for now.
  }
}

/** Parses transcripts directly, bypassing the fragment cache (`--no-cache`). */
class InMemorySessionStore implements SessionStore {
  readonly stats = undefined;
  diagnostics: ParserDiagnostic[] = [];

  constructor(private readonly opts: SessionStoreOptions) {}

  async read(query?: SessionQuery): Promise<ParseResult> {
    return applySessionQuery(parseAll({ sources: this.opts.sources }), query);
  }

  async close(): Promise<void> {}
}

export function openSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  return opts.cache === false
    ? new InMemorySessionStore(opts)
    : new FragmentBackedSessionStore(opts);
}
