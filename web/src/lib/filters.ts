// The global dashboard filters (date range + source) threaded into every view endpoint's query
// string; the server pushes them down to the store read. `project` stays a client-side refine in the
// Sessions list because the UI's project label isn't the working directory the server filters on.
export interface SnapshotFilters {
  since?: string;
  until?: string;
  source?: string;
}

export const KNOWN_SOURCES = ["claude", "codex", "gemini", "cowork", "claude-chat"] as const;

/** Only forward a source the server recognizes; an unknown value (e.g. a stray `source:` token typed
 *  into the Sessions search) would otherwise 400 the request. "all"/unset means no filter. */
export function sanitizedSource(source: string | undefined): string | null {
  return source && (KNOWN_SOURCES as readonly string[]).includes(source) ? source : null;
}

/** Append the shared since/until/source params to a query string (source gated by the known set). */
export function appendViewParams(params: URLSearchParams, filters: SnapshotFilters): void {
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  const source = sanitizedSource(filters.source);
  if (source) params.set("source", source);
}
