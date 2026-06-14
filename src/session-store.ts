// The SessionStore is the stable seam between data collection and everything downstream
// (analysis + reporting). It ensures the trusted store is materialized (producers reconcile at index
// time), then serves the reconciled sessions/messages via read(), pushing query filters down to SQL.
// Consumers never reconcile or post-filter in memory.
import {
  parseAllIncrementalDetailed,
  type SyncStats,
} from "./parse-incremental.ts";
import type { TranscriptSource } from "./parse.ts";
import type { ParserDiagnostic } from "./store-contract.ts";
import type { AgentSource, ParseResult } from "./types.ts";

/** Filters applied to the materialized read model at read time (SQL pushdown). */
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

/** Collection-time configuration: which sources to gather and where the store lives. */
export interface SessionStoreOptions {
  /** Sources to collect. Omit to use the parse defaults. */
  sources?: TranscriptSource[];
  /** Override the store path. */
  cachePath?: string;
  /** AgentsView import behavior. */
  agentsView?: "auto" | "off";
  /** Read a specific AgentsView sessions.db. */
  agentsViewDatabasePath?: string;
}

export interface SessionStore {
  /** Read the reconciled sessions/messages, optionally filtered (SQL pushdown). */
  read(query?: SessionQuery): Promise<ParseResult>;
  /** Sync stats from the most recent read. */
  readonly stats?: SyncStats;
  /** Collection diagnostics from the most recent read. */
  readonly diagnostics: ParserDiagnostic[];
  close(): Promise<void>;
}

/** Ensures the store is materialized, then reads the reconciled read model (no reconcile on read). */
class StoreBackedSessionStore implements SessionStore {
  stats?: SyncStats;
  diagnostics: ParserDiagnostic[] = [];

  constructor(private readonly opts: SessionStoreOptions) {}

  async read(query?: SessionQuery): Promise<ParseResult> {
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
    // parseAllIncrementalDetailed owns and closes its own store handle for now.
  }
}

export function openSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  return new StoreBackedSessionStore(opts);
}
