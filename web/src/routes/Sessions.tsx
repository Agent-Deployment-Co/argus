import { Link, Navigate, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Calendar, FilterX, Layers, Search, Tag } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { compactProject, dayStamp, fmt, usd } from "../lib/format";
import { useSessionsQuery, type SessionListFilters } from "../lib/sessions";
import { useLabelsQuery } from "../lib/labels";
import { FilterDropdown, FilterDropdownOption } from "../components/FilterDropdown";
import { DATE_PRESETS, formatDateShort, SORTED_SOURCES, sourceLabel } from "../lib/filters";
import { daysAgo } from "../router";
import type { SessionListItem, SessionSort } from "../types";

/** Sessions-local search params (the date range lives on this route too — see sessionsRoute in
 *  router.tsx — since /sessions owns its own search-first toolbar rather than the shared FilterBar). */
export interface SessionsSearch {
  since?: string;
  until?: string;
  source?: string;
  project?: string;
  file?: string;
  sort?: SessionSort;
  q?: string;
  /** Comma-separated label ids (union filter). */
  label?: string;
}

/** Parse the comma-separated `?label=` search param into an array of label ids. */
function labelIdsFromSearch(search: Record<string, unknown>): string[] {
  const raw = search.label;
  return typeof raw === "string" && raw ? raw.split(",").filter(Boolean) : [];
}

/** A human-facing title for a session: the model-generated title when the session has been interpreted
 *  (#234), else its opening prompt, else the summary, else a placeholder. Accepts both the list-lite
 *  item and the full row. */
export function sessionTitle(s: { title?: string | null; firstPrompt?: string | null; summary?: string | null }): string {
  const title = s.title?.trim();
  if (title) return title;
  const prompt = s.firstPrompt?.trim();
  if (prompt) return prompt.length > 90 ? prompt.slice(0, 90) + "…" : prompt;
  const summary = s.summary?.trim().replace(/^"|"$/g, "");
  if (summary) return summary;
  return "(untitled session)";
}

// The store wraps matched spans in these sentinel delimiters (char(1)/char(2)), not HTML, so we
// split-and-wrap here instead of dangerouslySetInnerHTML (#155).
const SNIPPET_MATCH_START = "";
const SNIPPET_MATCH_END = "";

/** Human label for a distilled (non-conversation) match source (#234): names where the snippet came
 *  from so a title/summary hit reads "session summary", not "task summary". */
const DISTILLED_SOURCE_LABEL: Record<"task" | "summary", string> = {
  summary: "session summary",
  task: "task summary",
};

/** Render a search-match snippet under a session row: the matched spans wrapped in <mark>, plus a
 *  match count and — when the match came from distilled interpretation text (task and/or session
 *  summary) — a label clarifying that's a restatement rather than raw dialogue. */
function SearchSnippet({ match }: { match: SessionListItem["match"] }) {
  if (!match) return null;
  const segments = match.snippet.split(SNIPPET_MATCH_START);
  const nodes: ReactNode[] = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const [hit, ...rest] = segments[i]!.split(SNIPPET_MATCH_END);
    nodes.push(<mark key={i}>{hit}</mark>, rest.join(SNIPPET_MATCH_END));
  }
  // Name each distilled source that matched (raw `conversation` needs no label — it's the dialogue).
  const distilledLabel = match.sources
    .filter((s): s is "task" | "summary" => s !== "conversation")
    .map((s) => DISTILLED_SOURCE_LABEL[s])
    .join(" & ");
  return (
    <div className="session-item-snippet">
      <span className="session-item-snippet-text">{nodes}</span>
      <span className="session-item-snippet-meta">
        {match.count} match{match.count === 1 ? "" : "es"}
        {distilledLabel && <> · in {distilledLabel}</>}
      </span>
    </div>
  );
}

/** Build the server-side query from the route's search params. */
function filtersFromSearch(search: Record<string, unknown>): SessionListFilters {
  return {
    since: typeof search.since === "string" ? search.since : undefined,
    until: typeof search.until === "string" ? search.until : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    file: typeof search.file === "string" && search.file ? search.file : undefined,
    label: labelIdsFromSearch(search),
    labelMode: search.labelMode === "all" ? "all" : "any",
    sort: (typeof search.sort === "string" ? (search.sort as SessionSort) : "recent") || "recent",
  };
}

/** Multi-select state for bulk mode, lifted above `SessionList` (into `Sessions`) so the detail pane
 *  can react to it too — not persisted across reload, and deliberately not part of the URL. */
export interface SessionSelection {
  ids: Set<string>;
  setIds: (ids: Set<string>) => void;
  /** The row last clicked without a modifier, or toggled via cmd/ctrl-click — the anchor a shift-click
   *  range extends from. */
  lastClickedId: string | null;
  setLastClickedId: (id: string | null) => void;
}

/** The session list pane: a plain "Showing X-Y of N sessions" head (the search/filter controls live
 *  in the toolbar above, rendered by `Sessions`) plus the scrollable row list. */
export function SessionList({ selection }: { selection: SessionSelection }) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { sessionId: selectedId } = useParams({ strict: false }) as { sessionId?: string };
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const query = useSessionsQuery(filters);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId, rows]);

  // j/k step the selection to the next/previous row, but only once a row is already selected —
  // otherwise they'd hijack normal typing (e.g. in the search box) with no selection to move. They
  // also always clear any multi-selection first: keyboard stepping and bulk-select never coexist
  // mid-navigation.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!selectedId) return;
      const idx = rows.findIndex((r) => r.sessionId === selectedId);
      if (idx === -1) return;
      const next = rows[e.key === "j" ? idx + 1 : idx - 1];
      if (!next) return;
      e.preventDefault();
      if (selection.ids.size > 0) selection.setIds(new Set());
      selection.setLastClickedId(null);
      navigate({ to: "/sessions/$sessionId", params: { sessionId: next.sessionId }, search: (prev: SessionsSearch) => prev });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selectedId, navigate, selection]);

  // Cmd/Ctrl-click toggles a row into/out of the selection; shift-click selects the contiguous range
  // from the last-clicked row to this one; a plain click clears any selection and navigates normally
  // (the default `Link` behavior, left untouched below). Both modifiers preventDefault so they override
  // the browser's native cmd/ctrl-click-opens-a-new-tab and shift-click-selects-text behavior.
  const handleRowClick = (e: MouseEvent, sessionId: string, index: number) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const next = new Set(selection.ids);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      selection.setIds(next);
      selection.setLastClickedId(sessionId);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      const anchorIdx = selection.lastClickedId ? rows.findIndex((r) => r.sessionId === selection.lastClickedId) : -1;
      if (anchorIdx === -1) {
        selection.setIds(new Set([sessionId]));
        selection.setLastClickedId(sessionId);
        return;
      }
      const [start, end] = anchorIdx < index ? [anchorIdx, index] : [index, anchorIdx];
      selection.setIds(new Set(rows.slice(start, end + 1).map((r) => r.sessionId)));
      return;
    }
    if (selection.ids.size > 0) selection.setIds(new Set());
    selection.setLastClickedId(sessionId);
  };

  return (
    <aside className="session-list" aria-label="Sessions">
      <div className="session-list-head session-list-head-count">
        {total === 0 ? "0 sessions" : `Showing 1-${rows.length} of ${total} sessions`}
      </div>
      <ul className="session-items">
        {query.isError && <li className="session-empty-row">{(query.error as Error).message}</li>}
        {rows.map((s, index) => (
          <li key={`${s.source}:${s.sessionId}`}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: s.sessionId }}
              search={(prev: SessionsSearch) => prev}
              className={`session-item${selection.ids.has(s.sessionId) ? " selected" : ""}`}
              activeProps={{ className: "active" }}
              ref={s.sessionId === selectedId ? activeRef : undefined}
              onClick={(e) => handleRowClick(e, s.sessionId, index)}
            >
              <div className="session-item-title">{sessionTitle(s)}</div>
              <div className="session-item-meta">
                <span className="muted nowrap">{dayStamp(s.start)}</span>
                <span className="truncate" title={s.project}>{compactProject(s.project)}</span>
              </div>
              <div className="session-item-stats">
                <span>{s.source}</span>
                {s.userMessages != null && <span>{fmt(s.userMessages)} user</span>}
                {s.agentMessages != null && <span>{fmt(s.agentMessages)} agent</span>}
                <span>{fmt(s.total)} tok</span>
                <span>{usd(s.cost)}</span>
              </div>
              {s.labels && s.labels.length > 0 && (
                <div className="session-item-labels">
                  {s.labels.map((l) => (
                    <span
                      key={l.id}
                      className={`label-chip label-chip--readonly${l.origin === "system" ? " label-chip--system" : ""}`}
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              <SearchSnippet match={s.match} />
            </Link>
          </li>
        ))}
        {query.isPending && <li className="session-empty-row">Loading sessions…</li>}
        {!query.isPending && !query.isError && !rows.length && (
          <li className="session-empty-row">No sessions match your filters.</li>
        )}
      </ul>
      {query.hasNextPage && (
        <button
          type="button"
          className="session-load-more"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? "Loading…" : `Load more (${total - rows.length} more)`}
        </button>
      )}
    </aside>
  );
}

/** Landing pane at /sessions (no session selected): jump to the first match, else show a hint. */
export function SessionsEmpty() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const query = useSessionsQuery(filters);
  const first: SessionListItem | undefined = query.data?.pages[0]?.rows[0];
  if (first) {
    return <Navigate to="/sessions/$sessionId" params={{ sessionId: first.sessionId }} search={search} replace />;
  }
  if (query.isPending) return <div className="session-empty">Loading sessions…</div>;
  if (query.isError) return <div className="session-empty">{(query.error as Error).message}</div>;
  const filtered = Boolean(
    filters.project || filters.q || filters.file || filters.source || filters.since || filters.until || filters.label?.length,
  );
  return <div className="session-empty">No sessions {filtered ? "match this filter" : "yet"}.</div>;
}

const DEFAULT_SINCE = daysAgo(30);
const DEFAULT_UNTIL = daysAgo(0);

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** /sessions: the rail + app shell, with a search-first toolbar (search box + labels/date/sources
 *  dropdowns) instead of the shared date/source FilterBar — see Layout's isSessions check for how
 *  the global FilterBar is suppressed for this route. The date range, search text, source, and labels
 *  are URL search params (?since=&until=&q=&source=&label=) so a shared link carries its state and the
 *  default range (last 30 days) is always loaded up front — see sessionsRoute's validateSearch in
 *  router.tsx. `source` is single-valued (not multi-select) because /api/sessions only ever filters
 *  by one source at a time; `label` is multi-valued (comma-separated ids, union match). */
export function Sessions() {
  const [labelSearch, setLabelSearch] = useState("");
  const labelCatalog = useLabelsQuery();

  // Bulk-select state (cmd/ctrl-click toggle, shift-click range) lives here, above `SessionList`, so
  // it can also drive the detail-pane overlay once 2+ sessions are selected.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [lastClickedId, setLastClickedId] = useState<string | null>(null);
  const selection: SessionSelection = useMemo(
    () => ({ ids: selectedIds, setIds: setSelectedIds, lastClickedId, setLastClickedId }),
    [selectedIds, lastClickedId],
  );

  const navigate = useNavigate();
  const { since, until, committedQ, source, labelIds, labelMode } = useSearch({
    strict: false,
    select: (s) => ({
      since: s.since ?? DEFAULT_SINCE,
      until: s.until ?? DEFAULT_UNTIL,
      committedQ: s.q ?? "",
      source: s.source,
      labelIds: labelIdsFromSearch(s as Record<string, unknown>),
      labelMode: s.labelMode === "all" ? "all" : "any",
    }),
  });
  const setRange = (patch: Record<string, string | undefined>) =>
    navigate({ to: ".", search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) });
  const today = daysAgo(0);
  const setSince = (v: string) => setRange({ since: v > today ? today : v > until ? until : v });
  const setUntil = (v: string) => setRange({ until: v > today ? today : v < since ? since : v });
  const setLabelIds = (ids: string[]) => setRange({ label: ids.length ? ids.join(",") : undefined });
  const setLabelMode = (mode: "any" | "all") => setRange({ labelMode: mode === "all" ? "all" : undefined });

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
  const labelNameById = useMemo(() => new Map((labelCatalog.data ?? []).map((l) => [l.id, l.name])), [labelCatalog.data]);
  const labelsSummary =
    labelIds.length === 0
      ? "Labels"
      : labelIds.length === 1
        ? (labelNameById.get(labelIds[0]!) ?? "1 label")
        : `${labelIds.length} labels`;
  const sourcesSummary = source ? sourceLabel(source) : "All sources";

  // Reset mirrors the shared FilterBar's reset (source + date range), plus the toolbar's own search
  // box and label selection — enabled only when one of those is off its default.
  const hasActiveFilters = Boolean(source) || !dateIsDefault || query.trim() !== "" || labelIds.length > 0;
  const resetFilters = () => {
    setQuery("");
    setRange({ since: undefined, until: undefined, source: undefined, q: undefined, label: undefined, labelMode: undefined });
  };

  const filteredLabels = (labelCatalog.data ?? []).filter((l) => l.name.toLowerCase().includes(labelSearch.toLowerCase()));

  // Cmd/Ctrl+K (or "/", the common search-focus shortcut) jumps focus to the search box and
  // selects its text, so typing replaces rather than appends, from anywhere on the page. "/" is
  // only honored outside text fields so it doesn't hijack normal typing (e.g. the labels search).
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      const target = e.target as HTMLElement | null;
      const inTextField = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const isSlash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !inTextField;
      if (!isCmdK && !isSlash) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="inbox-page">
      <div className="inbox-toolbar" role="group" aria-label="Session filters">
        <span className="inbox-search">
          <Search className="inbox-search-icon" size={16} strokeWidth={1.75} aria-hidden />
          <input
            ref={searchInputRef}
            type="search"
            className="inbox-search-input"
            placeholder="Search sessions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            aria-label="Search sessions"
          />
        </span>

        <div className="inbox-toolbar-filters">
          <FilterDropdown
            icon={<Tag size={14} strokeWidth={2} aria-hidden />}
            label="Labels"
            summary={labelsSummary}
            active={labelIds.length > 0}
            onClear={labelIds.length > 0 ? () => setLabelIds([]) : undefined}
            align="right"
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
                <FilterDropdownOption
                  key={l.id}
                  label={l.name}
                  selected={labelIds.includes(l.id)}
                  onToggle={() => setLabelIds(toggle(labelIds, l.id))}
                />
              ))}
              {filteredLabels.length === 0 && (
                <p className="filter-dropdown-empty">
                  {(labelCatalog.data ?? []).length === 0 ? "No labels yet." : "No labels match."}
                </p>
              )}
            </div>
            <div className="filter-dropdown-mode" role="radiogroup" aria-label="How to combine selected labels">
              <button
                type="button"
                className={`filter-dropdown-mode-btn${labelMode === "any" ? " active" : ""}`}
                role="radio"
                aria-checked={labelMode === "any"}
                onClick={() => setLabelMode("any")}
              >
                Match any
              </button>
              <button
                type="button"
                className={`filter-dropdown-mode-btn${labelMode === "all" ? " active" : ""}`}
                role="radio"
                aria-checked={labelMode === "all"}
                onClick={() => setLabelMode("all")}
              >
                Match all
              </button>
            </div>
          </FilterDropdown>

          <FilterDropdown
            icon={<Calendar size={14} strokeWidth={2} aria-hidden />}
            label="Date"
            summary={dateSummary}
            active={!dateIsDefault}
            onClear={dateIsDefault ? undefined : () => setRange({ since: undefined, until: undefined })}
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
                      className={`filter-dropdown-preset${since === daysAgo(p.days) && until === daysAgo(0) ? " active" : ""}`}
                      onClick={() => {
                        setRange({ since: daysAgo(p.days), until: daysAgo(0) });
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
              </>
            )}
          </FilterDropdown>

          <FilterDropdown
            icon={<Layers size={14} strokeWidth={2} aria-hidden />}
            label="Sources"
            summary={sourcesSummary}
            active={Boolean(source)}
            onClear={source ? () => setRange({ source: undefined }) : undefined}
            align="right"
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

          <button
            type="button"
            className="inbox-filter-reset"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            title="Reset filters to the last 30 days, all sources"
            aria-label="Reset filters"
          >
            <FilterX size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      </div>

      <div className="sessions-split">
        <SessionList selection={selection} />
        <div className="session-detail">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
