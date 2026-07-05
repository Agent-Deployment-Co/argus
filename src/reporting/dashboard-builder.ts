// Source-selection helpers shared across the CLI and the serve path. (The old monolithic
// buildDashboard()/buildSnapshot() builders were removed in #217: serve now reads each view straight
// off argus.db via per-view store methods + endpoints, and `argus sync` uploads raw resolved rows —
// neither assembles a Dashboard object anymore.)
import type { TranscriptSource } from "../types.ts";

/** Inputs the serve path needs — a narrow slice of the CLI flags so non-CLI callers don't have to
 *  construct the whole Flags object. Consumed as `serve`'s base options (per-request filters fall back
 *  to these). */
export interface BuildDashboardOptions {
  source: "all" | TranscriptSource;
  since?: string;
  until?: string;
  project?: string;
  /** Read the store without reconciling first (no writes). Set by the serve/upload legs of
   *  `argus run`, where the index leg is the sole writer; left false for one-shot commands. */
  readOnly?: boolean;
  /** Drop local-only sources (claude.ai chat is personal usage with estimated, not metered, tokens —
   *  it stays in the local web app only). Set by the sync upload path; left false for serve/index. */
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
