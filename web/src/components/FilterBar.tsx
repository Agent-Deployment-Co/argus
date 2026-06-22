import { useNavigate, useSearch } from "@tanstack/react-router";
import { Loader2, X } from "lucide-react";
import { KNOWN_SOURCES } from "../lib/snapshot";
import type { RootSearch } from "../router";

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

  const active = Boolean(since || until || source);

  return (
    <div className="filter-bar" role="group" aria-label="Dashboard filters">
      <label className="filter-field">
        <span>From</span>
        <input
          type="date"
          value={since ?? ""}
          max={until || undefined}
          onChange={(e) => set({ since: e.target.value || undefined })}
        />
      </label>
      <label className="filter-field">
        <span>To</span>
        <input
          type="date"
          value={until ?? ""}
          min={since || undefined}
          onChange={(e) => set({ until: e.target.value || undefined })}
        />
      </label>
      <label className="filter-field">
        <span>Source</span>
        <select value={source ?? ""} onChange={(e) => set({ source: e.target.value || undefined })}>
          <option value="">All sources</option>
          {KNOWN_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s] ?? s}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <button
          type="button"
          className="filter-clear"
          onClick={() => set({ since: undefined, until: undefined, source: undefined })}
          title="Clear filters"
        >
          <X size={14} strokeWidth={2} aria-hidden /> Clear
        </button>
      )}
      {refreshing && <Loader2 className="filter-spinner" size={15} strokeWidth={2} aria-label="Updating" />}
    </div>
  );
}
