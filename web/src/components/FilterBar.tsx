import { useNavigate, useSearch } from "@tanstack/react-router";
import { FilterX, Loader2 } from "lucide-react";
import { KNOWN_SOURCES } from "../lib/snapshot";
import { daysAgo, type RootSearch } from "../router";

const SOURCE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  cowork: "Cowork",
};

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

  return (
    <div className="filter-bar" role="group" aria-label="Dashboard filters">
      <span className="filter-dates">
        <input
          type="date"
          className="filter-input"
          aria-label="From date"
          value={since ?? ""}
          max={until || undefined}
          onChange={(e) => set({ since: e.target.value || undefined })}
        />
        <span className="filter-dash" aria-hidden>–</span>
        <input
          type="date"
          className="filter-input"
          aria-label="To date"
          value={until ?? ""}
          min={since || undefined}
          onChange={(e) => set({ until: e.target.value || undefined })}
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
          {KNOWN_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s] ?? s}
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
