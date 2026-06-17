import { Link, Outlet } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { compactProject, dayStamp, fmt } from "../lib/format";
import { useSnapshot } from "../lib/snapshot";
import type { SessionRow } from "../types";

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
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => [...d.sessions].sort((a, b) => b.start - a.start), [d.sessions]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return sorted;
    return sorted.filter(
      (s) =>
        sessionTitle(s).toLowerCase().includes(term) ||
        s.project.toLowerCase().includes(term) ||
        (s.source ?? "").toLowerCase().includes(term),
    );
  }, [sorted, query]);

  return (
    <aside className="session-list" aria-label="Sessions">
      <div className="session-list-head">
        <input
          className="session-search"
          type="search"
          placeholder="Filter sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="session-count">{filtered.length === sorted.length ? sorted.length : `${filtered.length} / ${sorted.length}`}</span>
      </div>
      <ul className="session-items">
        {filtered.map((s) => (
          <li key={`${s.source}:${s.sessionId}`}>
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: s.sessionId }}
              className="session-item"
              activeProps={{ className: "active" }}
            >
              <div className="session-item-title">{sessionTitle(s)}</div>
              <div className="session-item-meta">
                <span className="muted nowrap">{dayStamp(s.start)}</span>
                <span className="truncate" title={s.project}>{compactProject(s.project)}</span>
              </div>
              <div className="session-item-stats">
                <span>{s.source}</span>
                <span>{s.messages} msg</span>
                <span>{fmt(s.total)} tok</span>
              </div>
            </Link>
          </li>
        ))}
        {!filtered.length && <li className="session-empty-row">No sessions match “{query}”.</li>}
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
  return <div className="session-empty">Select a session on the left to see its details.</div>;
}
