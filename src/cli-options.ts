// Shared option shapes and the citty-args → options converters, factored out of cli.ts so the
// command bodies (index-ops.ts), the long-running loops (watch.ts), and the orchestrator (run.ts)
// can reuse them without importing cli.ts (which would create a cycle).
import type { TranscriptSource } from "./types.ts";
import type { BuildDashboardOptions } from "./reporting/dashboard-builder.ts";

export type Source = "all" | TranscriptSource;

/** The store-selection slice shared by `index`, its subcommands, and `index delete --archived`. */
export interface SyncOptions {
  source: Source;
}

export interface DeleteOptions {
  source: Source;
  archived: boolean;
  ids: string[];
}

/** `argus index refresh`: bare (ids empty) re-reads all; with ids, reindexes only those sessions.
 *  `extractTasks` is the tri-state `--extract-tasks` override (undefined = defer to argus.json). */
export interface RefreshOptions extends SyncOptions {
  ids: string[];
  extractTasks?: boolean;
  /** Test seam: override the store path for targeted refresh (the CLI uses the default store). */
  storePath?: string;
}

/** Narrow a raw `--source` value to the accepted set, exiting with a clear message otherwise. */
export function toSource(value: string): Source {
  if (value === "all" || value === "claude" || value === "codex" || value === "gemini" || value === "cowork") return value;
  console.error(`Invalid --source: ${value} (expected claude, codex, gemini, cowork, or all)`);
  process.exit(2);
}

/** The source-selection citty args shared by every store-reading command. */
export type SyncArgs = { source: string };
/** The full dashboard-building citty args (source + date/project filters). */
export type BuildArgs = SyncArgs & { since?: string; until?: string; project?: string };

export function syncOptions(args: SyncArgs): SyncOptions {
  return {
    source: toSource(args.source),
  };
}

export function buildOptions(args: BuildArgs): BuildDashboardOptions {
  return {
    ...syncOptions(args),
    since: args.since,
    until: args.until,
    project: args.project,
  };
}
