// The global dashboard filters (date range + source) threaded into every view endpoint's query
// string; the server pushes them down to the store read. `project` stays a client-side refine in the
// Sessions list because the UI's project label isn't the working directory the server filters on.
import { SOURCE_IDS, SOURCE_IDS_BY_LABEL, sourceLabel } from "../../../src/sources";

export interface SnapshotFilters {
  since?: string;
  until?: string;
  source?: string;
}

// Source ids, labels, and the alpha-by-label picker order all come from the canonical registry
// (src/sources) now — no hardcoded copies here. Re-exported so existing importers are unchanged.
export { sourceLabel };
export const KNOWN_SOURCES = SOURCE_IDS;

/** KNOWN_SOURCES ordered by display name, ascending alpha — the order every source picker should use. */
export const SORTED_SOURCES = SOURCE_IDS_BY_LABEL;

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

/** Shared date-range presets for the FilterDropdown "Date" panel (global FilterBar + /sessions toolbar). */
export const DATE_PRESETS = [
  { label: "Today", days: 0 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
] as const;

/** Short "Mon D" rendering of a YYYY-MM-DD date, for a FilterDropdown's pill summary. */
export function formatDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
