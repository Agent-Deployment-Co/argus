// The SessionStore is the stable seam between data collection and everything downstream
// (analysis + reporting). It separates the write from the read (CQS): `index()` brings the trusted
// store current (producers reconcile + materialize), and `read()` is a pure SQL read of that store —
// reading never writes. Consumers never reconcile or post-filter in memory.
import {
  parseAllIncrementalDetailed,
  readStore,
  type SyncStats,
} from "../indexing/pipeline.ts";
import type { TranscriptSource } from "../types.ts";
import type { ParserDiagnostic } from "./store-contract.ts";
import type { AgentSource, ParseResult } from "../types.ts";
import type { ResolvedSessionInterpretation } from "../config.ts";

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
  storePath?: string;
  /** Opt-in index-time task extraction (#91). Used by index(); off/unset → no extraction. */
  taskExtraction?: ResolvedSessionInterpretation;
  /** Keep prompt/response text in the local store (#120). Default-on; unset → retained. Local-only. */
  retainText?: boolean;
  /** Optional progress sink for long-running work (task extraction), wired to the command's logger. */
  log?: (message: string) => void;
}

export interface SessionStore {
  /** Pure read of the materialized store, optionally filtered (SQL pushdown). Never writes. */
  read(query?: SessionQuery): Promise<ParseResult>;
  /** Bring the store current (producers reconcile + materialize), then read. The only writer. */
  index(query?: SessionQuery): Promise<ParseResult>;
  /** Sync stats from the most recent index(), or from a read() that had to fall back to a temporary
   *  store (`fallback: true`). Undefined after a normal read() — a pure read does no sync. */
  readonly stats?: SyncStats;
  /** Collection diagnostics from the most recent read()/index(). */
  readonly diagnostics: ParserDiagnostic[];
  close(): Promise<void>;
}

/** CQS over the pipeline: read() is a pure SQL read; index() reconciles + materializes first. */
class StoreBackedSessionStore implements SessionStore {
  stats?: SyncStats;
  diagnostics: ParserDiagnostic[] = [];

  constructor(private readonly opts: SessionStoreOptions) {}

  async read(query?: SessionQuery): Promise<ParseResult> {
    const details = await readStore({
      sources: this.opts.sources,
      storePath: this.opts.storePath,
      log: this.opts.log,
      query,
    });
    this.diagnostics = details.diagnostics;
    // A pure read does no sync, so it has no meaningful sync stats — except a degraded read, which
    // indexes into a temp store and is worth surfacing (fallback). Leave stats undefined otherwise
    // so a caller can't mistake a read for an index that found nothing to do.
    this.stats = details.stats.fallback ? details.stats : undefined;
    return details.parsed;
  }

  async index(query?: SessionQuery): Promise<ParseResult> {
    const details = await parseAllIncrementalDetailed({
      sources: this.opts.sources,
      storePath: this.opts.storePath,
      taskExtraction: this.opts.taskExtraction,
      retainText: this.opts.retainText,
      log: this.opts.log,
      query,
    });
    this.stats = details.stats;
    this.diagnostics = details.diagnostics;
    return details.parsed;
  }

  async close(): Promise<void> {
    // The pipeline owns and closes its own store handle per call for now.
  }
}

export function openSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  return new StoreBackedSessionStore(opts);
}
