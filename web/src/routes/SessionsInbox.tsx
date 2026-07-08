import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { Calendar, Layers, Search, Tag } from "lucide-react";
import { useEffect, useState } from "react";
import { FilterDropdown, FilterDropdownOption } from "../components/FilterDropdown";
import { SORTED_SOURCES, sourceLabel } from "../lib/filters";
import { daysAgo } from "../router";
import { SessionList, SessionsEmpty } from "./Sessions";

/** The /sessions-inbox index child (no session selected) — same landing behavior as /sessions's,
 *  just pointed at this route's own $sessionId path so it doesn't redirect out to /sessions. */
export function SessionsInboxEmpty() {
  return <SessionsEmpty detailPath="/sessions-inbox/$sessionId" />;
}

// Standing labels aren't implemented yet — this is a placeholder set so the dropdown has something
// to filter by. Alphabetical (no inherent ranking yet).
const DUMMY_LABELS = ["Blocked", "Escalated", "Follow-up", "Needs review", "Resolved"];

const DEFAULT_SINCE = daysAgo(30);
const DEFAULT_UNTIL = daysAgo(0);

const DATE_PRESETS = [
  { label: "Today", days: 0 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

function formatDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Testbed for a new sessions UI (#sessions-inbox): same rail as the rest of the app, but a
 *  search-first toolbar instead of the shared date/source FilterBar. Filters here are local UI state
 *  only (not wired to data yet) — see Layout's isSessionsInbox check for how the global FilterBar is
 *  suppressed for this route. */
export function SessionsInbox() {
  const [labelSearch, setLabelSearch] = useState("");
  const [labels, setLabels] = useState<string[]>([]);

  // The date range, search text, and source are URL search params (?since=&until=&q=&source=), same
  // convention as the shared FilterBar/Sessions list, so a link into this page carries its state and
  // the default range (last 30 days) is always loaded up front — see the route's validateSearch in
  // router.tsx. The session list itself (SessionList, rendered below with showHead={false}) reads
  // these the same way regardless of who writes them, so wiring the toolbar here is all this needs.
  // `source` is single-valued (not multi-select) because /api/sessions — like the rest of the app —
  // only ever filters by one source at a time.
  const navigate = useNavigate();
  const { since, until, committedQ, source } = useSearch({
    strict: false,
    select: (s) => ({ since: s.since ?? DEFAULT_SINCE, until: s.until ?? DEFAULT_UNTIL, committedQ: s.q ?? "", source: s.source }),
  });
  const setRange = (patch: Record<string, string | undefined>) =>
    navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) });
  const today = daysAgo(0);
  const setSince = (v: string) => setRange({ since: v > today ? today : v > until ? until : v });
  const setUntil = (v: string) => setRange({ until: v > today ? today : v < since ? since : v });

  // Local text mirrors the committed `q`; debounce edits into the URL so we don't refetch per keystroke.
  const [query, setQuery] = useState(committedQ);
  useEffect(() => setQuery(committedQ), [committedQ]);
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === committedQ) return;
    const t = setTimeout(() => setRange({ q: trimmed || undefined }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const dateIsDefault = since === DEFAULT_SINCE && until === DEFAULT_UNTIL;
  const dateSummary = `${formatDateShort(since)} → ${formatDateShort(until)}`;
  const labelsSummary = labels.length === 0 ? "Labels" : labels.length === 1 ? labels[0] : `${labels.length} labels`;
  const sourcesSummary = source ? sourceLabel(source) : "Sources";

  const filteredLabels = DUMMY_LABELS.filter((l) => l.toLowerCase().includes(labelSearch.toLowerCase()));

  return (
    <div className="inbox-page">
      <div className="inbox-toolbar" role="group" aria-label="Inbox filters">
        <span className="inbox-search">
          <Search className="inbox-search-icon" size={16} strokeWidth={1.75} aria-hidden />
          <input
            type="search"
            className="inbox-search-input"
            placeholder="Search sessions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search sessions"
          />
        </span>

        <FilterDropdown
          icon={<Tag size={14} strokeWidth={2} aria-hidden />}
          label="Labels"
          summary={labelsSummary}
          active={labels.length > 0}
          onClear={labels.length > 0 ? () => setLabels([]) : undefined}
        >
          <input
            type="search"
            className="filter-dropdown-search"
            placeholder="Search labels"
            value={labelSearch}
            onChange={(e) => setLabelSearch(e.target.value)}
            aria-label="Search labels"
          />
          <div className="filter-dropdown-list" role="listbox" aria-label="Labels">
            {filteredLabels.map((l) => (
              <FilterDropdownOption key={l} label={l} selected={labels.includes(l)} onToggle={() => setLabels((prev) => toggle(prev, l))} />
            ))}
            {filteredLabels.length === 0 && <p className="filter-dropdown-empty">No labels match.</p>}
          </div>
        </FilterDropdown>

        <FilterDropdown
          icon={<Calendar size={14} strokeWidth={2} aria-hidden />}
          label="Date"
          summary={dateSummary}
          active={!dateIsDefault}
          onClear={dateIsDefault ? undefined : () => setRange({ since: undefined, until: undefined })}
        >
          <div className="filter-dropdown-presets">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="filter-dropdown-preset"
                onClick={() => setRange({ since: daysAgo(p.days), until: daysAgo(0) })}
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
              onChange={(e) => e.target.value && setSince(e.target.value)}
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
              onChange={(e) => e.target.value && setUntil(e.target.value)}
            />
          </div>
        </FilterDropdown>

        <FilterDropdown
          icon={<Layers size={14} strokeWidth={2} aria-hidden />}
          label="Sources"
          summary={sourcesSummary}
          active={Boolean(source)}
          onClear={source ? () => setRange({ source: undefined }) : undefined}
        >
          <div className="filter-dropdown-list" role="listbox" aria-label="Sources">
            {SORTED_SOURCES.map((s) => (
              <FilterDropdownOption
                key={s}
                label={sourceLabel(s)}
                selected={source === s}
                onToggle={() => setRange({ source: source === s ? undefined : s })}
              />
            ))}
          </div>
        </FilterDropdown>
      </div>

      <div className="sessions-split">
        <SessionList showHead={false} detailPath="/sessions-inbox/$sessionId" />
        <div className="session-detail">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
