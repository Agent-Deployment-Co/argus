import { useNavigate, useSearch } from "@tanstack/react-router";
import { Calendar, FilterX, Layers, Loader2 } from "lucide-react";
import { DATE_PRESETS, formatDateShort, SORTED_SOURCES, sourceLabel } from "../lib/filters";
import { daysAgo, type RootSearch } from "../router";
import { FilterDropdown, FilterDropdownOption } from "./FilterDropdown";

/** Global dashboard filters (date range + source) shown above every view, centered. Edits the
 *  root search params; `retainSearchParams` keeps them in the URL as the user moves between tabs, and
 *  the snapshot query refetches the narrowed slice. `project` is deliberately not here — it stays a
 *  client-side refine in the Sessions list (the UI label isn't the path the server filters on).
 *  Borrows its Date/Sources pills and reset icon from the /sessions inbox-toolbar (FilterDropdown) so
 *  the two filter UIs read as one system — see Sessions.tsx for the sibling toolbar. */
export function FilterBar({ refreshing }: { refreshing: boolean }) {
  const navigate = useNavigate();
  const { since, until, source } = useSearch({
    strict: false,
    select: (s) => ({ since: s.since ?? daysAgo(30), until: s.until ?? daysAgo(0), source: s.source }),
  });

  const set = (patch: Partial<RootSearch>) =>
    navigate({ to: ".", search: (prev: RootSearch) => ({ ...prev, ...patch }) });

  // Default = last 30 days, all sources (see the root route's validateSearch). Resetting clears the
  // params so those defaults reapply. The button is always shown but disabled while at defaults.
  const today = daysAgo(0);
  const dateIsDefault = since === daysAgo(30) && until === today;
  const isDefault = dateIsDefault && !source;

  // Keep the range sane: no future dates, and `to` never before `from`. The native min/max guide the
  // picker; the handlers also clamp so a typed/invalid value can't slip an out-of-range date through.
  // (Dates are YYYY-MM-DD, so lexical comparison is chronological.)
  const setSince = (v: string) => v && set({ since: v > today ? today : v > until ? until : v });
  const setUntil = (v: string) => v && set({ until: v > today ? today : v < since ? since : v });

  const dateSummary = `${formatDateShort(since)} → ${formatDateShort(until)}`;
  const sourcesSummary = source ? sourceLabel(source) : "All sources";

  return (
    <div className="filter-bar" role="group" aria-label="Dashboard filters">
      <FilterDropdown
        icon={<Calendar size={14} strokeWidth={2} aria-hidden />}
        label="Date"
        summary={dateSummary}
        active={!dateIsDefault}
        onClear={dateIsDefault ? undefined : () => set({ since: undefined, until: undefined })}
        clearLabel="Reset"
        align="right"
      >
        {(close) => (
          <>
            <div className="filter-dropdown-presets">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`filter-dropdown-preset${since === daysAgo(p.days) && until === today ? " active" : ""}`}
                  onClick={() => {
                    set({ since: daysAgo(p.days), until: today });
                    close();
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="filter-dropdown-dates">
              <input
                type="date"
                className="filter-input"
                aria-label="From date"
                value={since}
                max={until}
                onChange={(e) => setSince(e.target.value)}
              />
              <span className="filter-dash" aria-hidden>
                –
              </span>
              <input
                type="date"
                className="filter-input"
                aria-label="To date"
                value={until}
                min={since}
                max={today}
                onChange={(e) => setUntil(e.target.value)}
              />
            </div>
          </>
        )}
      </FilterDropdown>

      <FilterDropdown
        icon={<Layers size={14} strokeWidth={2} aria-hidden />}
        label="Sources"
        summary={sourcesSummary}
        active={Boolean(source)}
        onClear={source ? () => set({ source: undefined }) : undefined}
        align="right"
      >
        <div className="filter-dropdown-list" role="listbox" aria-label="Sources">
          {SORTED_SOURCES.map((s) => (
            <FilterDropdownOption
              key={s}
              label={sourceLabel(s)}
              selected={source === s}
              onToggle={() => set({ source: source === s ? undefined : s })}
            />
          ))}
        </div>
      </FilterDropdown>

      <button
        type="button"
        className="inbox-filter-reset"
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
