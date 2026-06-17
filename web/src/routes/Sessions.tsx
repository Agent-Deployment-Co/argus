import { Link, Navigate, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { compactProject, dayStamp, fmt } from "../lib/format";
import { useSnapshot } from "../lib/snapshot";
import type { SessionRow } from "../types";

type FilterKey = "project" | "source";

export interface SessionsSearch {
  project?: string;
  source?: string;
}

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

/** Sessions sorted newest-first and narrowed by the URL filters (project/source). */
function sessionsForSearch(sessions: SessionRow[], { project, source }: SessionsSearch): SessionRow[] {
  const proj = project?.toLowerCase();
  const src = source?.toLowerCase();
  return [...sessions]
    .sort((a, b) => b.start - a.start)
    .filter((s) => {
      if (proj && !s.project.toLowerCase().includes(proj)) return false;
      if (src && (s.source ?? "").toLowerCase() !== src) return false;
      return true;
    });
}

/** A human-facing title for a session: its opening prompt, else the summary, else a placeholder. */
export function sessionTitle(s: SessionRow): string {
  const prompt = s.firstPrompt?.trim();
  if (prompt) return prompt.length > 90 ? prompt.slice(0, 90) + "…" : prompt;
  const summary = s.summary?.trim().replace(/^"|"$/g, "");
  if (summary) return summary;
  return "(untitled session)";
}

function SessionList() {
  const { dashboard: d } = useSnapshot();
  const navigate = useNavigate();
  const { project, source } = useSearch({ from: "/sessions" });
  const { sessionId: selectedId } = useParams({ strict: false }) as { sessionId?: string };
  const [query, setQuery] = useState("");
  const activeRef = useRef<HTMLAnchorElement | null>(null);

  const setFilter = (key: FilterKey, value: string | undefined) =>
    navigate({ to: ".", search: (prev: SessionsSearch) => ({ ...prev, [key]: value || undefined }) });

  // Filter as you type. A `project:value ` / `source:value ` token (terminated by a space) becomes
  // a filter; anything else is free text.
  const onQueryChange = (raw: string) => {
    const token = extractFilterToken(raw, true);
    if (token) {
      setFilter(token.key, token.value);
      setQuery(token.rest);
    } else {
      setQuery(raw);
    }
  };

  // Enter commits a bare token (no trailing space needed).
  const onQueryKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const token = extractFilterToken(query, false);
    if (token) {
      e.preventDefault();
      setFilter(token.key, token.value);
      setQuery(token.rest);
    }
  };

  const byUrl = useMemo(() => sessionsForSearch(d.sessions, { project, source }), [d.sessions, project, source]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return byUrl;
    return byUrl.filter(
      (s) =>
        sessionTitle(s).toLowerCase().includes(term) ||
        s.project.toLowerCase().includes(term) ||
        (s.source ?? "").toLowerCase().includes(term),
    );
  }, [byUrl, query]);
  const total = d.sessions.length;

  const activeFilters = ([["project", project], ["source", source]] as const).filter(([, v]) => Boolean(v));

  // Bring the selected session into view (e.g. on a deep link to /sessions/:id).
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId, filtered]);

  return (
    <aside className="session-list" aria-label="Sessions">
      <div className="session-list-head">
        <div className="session-search-row">
          <input
            className="session-search"
            type="search"
            placeholder="Filter sessions…"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onQueryKeyDown}
          />
          <span className="session-count">{filtered.length === total ? total : `${filtered.length} / ${total}`}</span>
        </div>
        {activeFilters.length > 0 && (
          <div className="session-filters">
            {activeFilters.map(([key, value]) => (
              <button key={key} type="button" className="filter-pill" onClick={() => setFilter(key, undefined)} title="Remove filter">
                {key}: {value}
                <span className="filter-pill-x" aria-hidden>×</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <ul className="session-items">
        {filtered.map((s) => (
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
              </div>
            </Link>
          </li>
        ))}
        {!filtered.length && <li className="session-empty-row">No sessions match your filters.</li>}
      </ul>
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

export function SessionsEmpty() {
  const { dashboard: d } = useSnapshot();
  const search = useSearch({ from: "/sessions" });
  const first = sessionsForSearch(d.sessions, search)[0];
  if (first) {
    return <Navigate to="/sessions/$sessionId" params={{ sessionId: first.sessionId }} search={search} replace />;
  }
  const filtered = Boolean(search.project || search.source);
  return <div className="session-empty">No sessions {filtered ? "match this filter" : "yet"}.</div>;
}
