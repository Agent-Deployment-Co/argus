import { Link, Navigate, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { compactProject, dayStamp, fmt, usd } from "../lib/format";
import { useSessionsQuery, type SessionListFilters } from "../lib/sessions";
import type { SessionListItem, SessionSort } from "../types";

type FilterKey = "project" | "source";

/** Sessions-local search params (the global date range + source live on the root route). */
export interface SessionsSearch {
  project?: string;
  source?: string;
  showGenerated?: boolean;
  sort?: SessionSort;
  q?: string;
}

const SORT_LABELS: Record<SessionSort, string> = {
  recent: "Most recent",
  tokens: "Most tokens",
  cost: "Highest cost",
};

/**
 * Pull a `project:value` / `source:value` token out of the raw search text. While typing we only
 * commit a token terminated by whitespace (so "project:a" mid-type stays as text); on Enter we
 * commit it bare.
 */
function extractFilterToken(raw: string, requireTerminator: boolean): { key: FilterKey; value: string; rest: string } | null {
  const m = raw.match(requireTerminator ? /(^|\s)(project|source):(\S+)\s/i : /(^|\s)(project|source):(\S+)/i);
  if (!m) return null;
  const rest = (raw.slice(0, m.index) + raw.slice(m.index! + m[0].length)).replace(/\s+/g, " ").trim();
  return { key: m[2]!.toLowerCase() as FilterKey, value: m[3]!, rest };
}

/** A human-facing title for a session: its opening prompt, else the heuristic summary (detail only),
 *  else a placeholder. Accepts both the list-lite item and the full row. */
export function sessionTitle(s: { firstPrompt?: string | null; summary?: string }): string {
  const prompt = s.firstPrompt?.trim();
  if (prompt) return prompt.length > 90 ? prompt.slice(0, 90) + "…" : prompt;
  const summary = s.summary?.trim().replace(/^"|"$/g, "");
  if (summary) return summary;
  return "(untitled session)";
}

/** Build the server-side query from the merged (global + Sessions-local) search params. */
function filtersFromSearch(search: Record<string, unknown>): SessionListFilters {
  return {
    since: typeof search.since === "string" ? search.since : undefined,
    until: typeof search.until === "string" ? search.until : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
    project: typeof search.project === "string" ? search.project : undefined,
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    includeGenerated: search.showGenerated === true,
    sort: (typeof search.sort === "string" ? (search.sort as SessionSort) : "recent") || "recent",
  };
}

function SessionList() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { sessionId: selectedId } = useParams({ strict: false }) as { sessionId?: string };
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  const project = typeof search.project === "string" ? search.project : undefined;
  const source = typeof search.source === "string" ? search.source : undefined;
  const showGenerated = search.showGenerated === true;
  const sort: SessionSort = (typeof search.sort === "string" ? (search.sort as SessionSort) : "recent") || "recent";
  const committedQ = typeof search.q === "string" ? search.q : "";

  // Local text mirrors the committed `q`; we debounce edits into the URL so we don't refetch per keystroke.
  const [text, setText] = useState(committedQ);
  useEffect(() => setText(committedQ), [committedQ]);

  const setSearch = (patch: Partial<SessionsSearch>) =>
    navigate({ to: ".", search: (prev: SessionsSearch) => ({ ...prev, ...patch }) });
  const setFilter = (key: FilterKey, value: string | undefined) => setSearch({ [key]: value || undefined });

  // Debounce free text → `q`.
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === committedQ) return;
    const t = setTimeout(() => setSearch({ q: trimmed || undefined }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const onQueryChange = (raw: string) => {
    const token = extractFilterToken(raw, true);
    if (token) {
      setFilter(token.key, token.value);
      setText(token.rest);
    } else {
      setText(raw);
    }
  };
  const onQueryKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const token = extractFilterToken(text, false);
    if (token) {
      e.preventDefault();
      setFilter(token.key, token.value);
      setText(token.rest);
    }
  };

  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const query = useSessionsQuery(filters);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  const activeFilters = ([["project", project], ["source", source]] as const).filter(([, v]) => Boolean(v));

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId, rows]);

  return (
    <aside className="session-list" aria-label="Sessions">
      <div className="session-list-head">
        <div className="session-search-row">
          <input
            className="session-search"
            type="search"
            placeholder="Filter sessions…"
            value={text}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onQueryKeyDown}
          />
          <span className="session-count">{rows.length === total ? total : `${rows.length} / ${total}`}</span>
        </div>
        <div className="session-filters">
          <select
            className="session-sort"
            value={sort}
            onChange={(e) => setSearch({ sort: e.target.value as SessionSort })}
            aria-label="Sort sessions"
          >
            {(Object.keys(SORT_LABELS) as SessionSort[]).map((s) => (
              <option key={s} value={s}>{SORT_LABELS[s]}</option>
            ))}
          </select>
          {activeFilters.map(([key, value]) => (
            <button key={key} type="button" className="filter-pill" onClick={() => setFilter(key, undefined)} title="Remove filter">
              {key}: {value}
              <span className="filter-pill-x" aria-hidden>×</span>
            </button>
          ))}
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={showGenerated}
              onChange={(event) => setSearch({ showGenerated: event.target.checked || undefined })}
            />
            <span>Argus sessions</span>
          </label>
        </div>
      </div>
      <ul className="session-items">
        {query.isError && <li className="session-empty-row">Couldn't load sessions: {(query.error as Error).message}</li>}
        {rows.map((s) => (
          <li key={`${s.source}:${s.sessionId}`}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: s.sessionId }}
              search={(prev: SessionsSearch) => prev}
              className="session-item"
              activeProps={{ className: "active" }}
              ref={s.sessionId === selectedId ? activeRef : undefined}
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

export function Sessions() {
  return (
    <div className="sessions-split">
      <SessionList />
      <div className="session-detail">
        <Outlet />
      </div>
    </div>
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
  const filtered = Boolean(filters.project || filters.q || filters.source || filters.since || filters.until);
  return <div className="session-empty">No sessions {filtered ? "match this filter" : "yet"}.</div>;
}
