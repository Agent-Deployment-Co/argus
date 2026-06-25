import { useNavigate, useSearch } from "@tanstack/react-router";
import { FilterX, Loader2 } from "lucide-react";
import { KNOWN_SOURCES } from "../lib/snapshot";
import { daysAgo, type RootSearch } from "../router";

const SOURCE_LABELS: Record<string, string> = {
  claude: "Claude Code",
  "claude-chat": "Claude Chat",
  cowork: "Claude Cowork",
  codex: "Codex",
  gemini: "Gemini"
};

const sourceLabel = (s: string): string => SOURCE_LABELS[s] ?? s;

// Source options ordered by display name, ascending alpha.
const SORTED_SOURCES = [...KNOWN_SOURCES].sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b)));

/** Global dashboard filters (date range + source) shown above every view. Edits the root search
 *  params; `retainSearchParams` keeps them in the URL as the user moves between tabs, and the
 *  snapshot query refetches the narrowed slice. `project` is deliberately not here — it stays a
 *  client-side refine in the Sessions list (the UI label isn't the path the server filters on). */
export function FilterBar({ refreshing }: { refreshing: boolean }) {
  const navigate = useNavigate();
  const { since, until, source } = useSearch({
    strict: false,
    select: (s) => ({ since: s.since, until: s.until, source: s.source }),
  });

  const set = (patch: Partial<RootSearch>) =>
    navigate({ to: ".", search: (prev: RootSearch) => ({ ...prev, ...patch }) });

  // Default = last 30 days, all sources (see the root route's validateSearch). Resetting clears the
  // params so those defaults reapply. The button is always shown but disabled while at defaults.
  const isDefault = since === daysAgo(30) && until === daysAgo(0) && !source;

  // Keep the range sane: no future dates, and `to` never before `from`. The native min/max guide the
  // picker; the handlers also clamp so a typed/invalid value can't slip an out-of-range date through.
  // (Dates are YYYY-MM-DD, so lexical comparison is chronological.)
  const today = daysAgo(0);
  const setSince = (v: string) => {
    if (!v) return set({ since: undefined });
    set({ since: v > today ? today : until && v > until ? until : v });
  };
  const setUntil = (v: string) => {
    if (!v) return set({ until: undefined });
    set({ until: v > today ? today : since && v < since ? since : v });
  };

  return (
    <div className="filter-bar" role="group" aria-label="Dashboard filters">
      <span className="filter-dates">
        <input
          type="date"
          className="filter-input"
          aria-label="From date"
          value={since ?? ""}
          max={until && until < today ? until : today}
          onChange={(e) => setSince(e.target.value)}
        />
        <span className="filter-dash" aria-hidden>–</span>
        <input
          type="date"
          className="filter-input"
          aria-label="To date"
          value={until ?? ""}
          min={since || undefined}
          max={today}
          onChange={(e) => setUntil(e.target.value)}
        />
      </span>
      <span className="select-wrap">
        <select
          className="filter-input"
          aria-label="Source"
          value={source ?? ""}
          onChange={(e) => set({ source: e.target.value || undefined })}
        >
          <option value="">All sources</option>
          {SORTED_SOURCES.map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
      </span>
      <button
        type="button"
        className="filter-reset"
        disabled={isDefault}
        onClick={() => set({ since: undefined, until: undefined, source: undefined })}
        title="Reset filters to the last 30 days, all sources"
        aria-label="Reset filters"
      >
        {refreshing ? (
          <Loader2 className="filter-spinner" size={16} strokeWidth={2} aria-label="Updating" />
        ) : (
          <FilterX size={16} strokeWidth={1.75} aria-hidden />
        )}
      </button>
    </div>
  );
}
