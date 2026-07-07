import { Link, Navigate, Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Archive, ArchiveRestore, List, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { compactProject, dayStamp } from "../lib/format";
import { inboxKey, useInboxArchive } from "../lib/inboxArchive";
import { useSessionsQuery, type SessionListFilters } from "../lib/sessions";
import type { SessionListItem } from "../types";
import { sessionTitle } from "./Sessions";

/** /sessions-inbox — a Gmail-inspired testing bed for a future /sessions redesign. Deliberately left
 *  out of the rail nav (Layout.tsx's NAV array): reachable only by direct URL while it's a prototype. */
export interface SessionsInboxSearch {
  folder?: "inbox" | "archived";
  q?: string;
}

function filtersFromSearch(search: Record<string, unknown>): SessionListFilters {
  return {
    since: typeof search.since === "string" ? search.since : undefined,
    until: typeof search.until === "string" ? search.until : undefined,
    source: typeof search.source === "string" ? search.source : undefined,
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    sort: "recent",
  };
}

function InboxSearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === value) return;
    const t = setTimeout(() => onChange(trimmed), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <div className="inbox-toolbar">
      <div className="inbox-search-wrap">
        <Search className="inbox-search-icon" size={16} strokeWidth={1.75} aria-hidden />
        <input
          className="inbox-search"
          type="search"
          placeholder="Search sessions"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Search sessions"
        />
      </div>
    </div>
  );
}

function InboxNav({
  folder,
  searching,
  onSelect,
}: {
  folder: "inbox" | "archived";
  searching: boolean;
  onSelect: (folder: "inbox" | "archived") => void;
}) {
  return (
    <nav className="inbox-nav" aria-label="Sessions inbox folders">
      <button
        type="button"
        className={`inbox-nav-item${!searching && folder === "inbox" ? " active" : ""}`}
        onClick={() => onSelect("inbox")}
      >
        <List size={16} strokeWidth={1.75} aria-hidden />
        <span>All</span>
      </button>
      <button
        type="button"
        className={`inbox-nav-item${!searching && folder === "archived" ? " active" : ""}`}
        onClick={() => onSelect("archived")}
      >
        <Archive size={16} strokeWidth={1.75} aria-hidden />
        <span>Archived</span>
      </button>
    </nav>
  );
}

function InboxRow({
  s,
  selectedId,
  archived,
  onArchiveToggle,
}: {
  s: SessionListItem;
  selectedId: string | undefined;
  archived: boolean;
  onArchiveToggle: () => void;
}) {
  return (
    <li className="inbox-row-wrap">
      <Link
        to="/sessions-inbox/$sessionId"
        params={{ sessionId: s.sessionId }}
        search={(prev: SessionsInboxSearch) => prev}
        className="inbox-row"
        activeProps={{ className: "active" }}
      >
        <span className="inbox-row-subject truncate">{sessionTitle(s)}</span>
        <span className="inbox-row-meta">
          <span>{s.source}</span>
          <span aria-hidden> - </span>
          <span className="truncate" title={s.project}>{compactProject(s.project)}</span>
          <span aria-hidden> - </span>
          <span className="nowrap">{dayStamp(s.start)}</span>
        </span>
      </Link>
      <button
        type="button"
        className="inbox-row-archive-btn"
        title={archived ? "Unarchive" : "Archive"}
        aria-label={archived ? "Unarchive" : "Archive"}
        onClick={(e) => {
          e.preventDefault();
          onArchiveToggle();
        }}
      >
        {archived ? <ArchiveRestore size={15} strokeWidth={1.75} /> : <Archive size={15} strokeWidth={1.75} />}
      </button>
    </li>
  );
}

export function SessionsInbox() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { sessionId: selectedId } = useParams({ strict: false }) as { sessionId?: string };
  const { archived, archive, unarchive } = useInboxArchive();

  const folder: "inbox" | "archived" = search.folder === "archived" ? "archived" : "inbox";
  const q = typeof search.q === "string" ? search.q : "";

  const setSearch = (patch: Partial<SessionsInboxSearch>) =>
    navigate({ to: ".", search: (prev: SessionsInboxSearch) => ({ ...prev, ...patch }) });

  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const query = useSessionsQuery(filters);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);

  const inboxRows = rows.filter((r) => !archived.has(inboxKey(r.source, r.sessionId)));
  const archivedRows = rows.filter((r) => archived.has(inboxKey(r.source, r.sessionId)));
  const visible = folder === "inbox" ? inboxRows : archivedRows;

  // "Archived" is a local-only concept (no server truth for it), so its total is just what's loaded;
  // "All" reports the server's real total for the current filters, minus what's been archived
  // locally out of the loaded page.
  const total =
    folder === "archived" ? archivedRows.length : (query.data?.pages[0]?.total ?? inboxRows.length) - archivedRows.length;
  const lower = visible.length ? 1 : 0;
  const upper = visible.length;
  const rangeLabel =
    total > 0 ? `${lower}-${upper} of ${total} session${total === 1 ? "" : "s"}` : "0 sessions";

  return (
    <div className="inbox-shell">
      <InboxSearchBar value={q} onChange={(v) => setSearch({ q: v || undefined })} />
      <div className="inbox-body">
        <InboxNav
          folder={folder}
          searching={Boolean(q)}
          onSelect={(f) => setSearch({ folder: f === "inbox" ? undefined : f, q: undefined })}
        />
        <div className="inbox-list-col">
          <div className="inbox-list-bar">{rangeLabel}</div>
          <ul className="inbox-list">
            {query.isError && <li className="session-empty-row">{(query.error as Error).message}</li>}
            {query.isPending && <li className="session-empty-row">Loading sessions…</li>}
            {!query.isPending && !query.isError && !visible.length && (
              <li className="session-empty-row">
                {folder === "inbox" ? "No sessions match your filters." : "No archived sessions."}
              </li>
            )}
            {visible.map((s) => {
              const key = inboxKey(s.source, s.sessionId);
              return (
                <InboxRow
                  key={key}
                  s={s}
                  selectedId={selectedId}
                  archived={folder === "archived"}
                  onArchiveToggle={() => (folder === "archived" ? unarchive(key) : archive(key))}
                />
              );
            })}
          </ul>
        </div>
        <div className="inbox-detail">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/** Landing pane at /sessions-inbox (no session selected): jump to the first row in the active folder. */
export function SessionsInboxEmpty() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { archived } = useInboxArchive();
  const folder: "inbox" | "archived" = search.folder === "archived" ? "archived" : "inbox";
  const filters = useMemo(() => filtersFromSearch(search), [search]);
  const query = useSessionsQuery(filters);
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const visible = rows.filter((r) => archived.has(inboxKey(r.source, r.sessionId)) === (folder === "archived"));
  const first: SessionListItem | undefined = visible[0];

  if (first) {
    return <Navigate to="/sessions-inbox/$sessionId" params={{ sessionId: first.sessionId }} search={search} replace />;
  }
  if (query.isPending) return <div className="session-empty">Loading sessions…</div>;
  if (query.isError) return <div className="session-empty">{(query.error as Error).message}</div>;
  return <div className="session-empty">{folder === "inbox" ? "No sessions yet." : "No archived sessions."}</div>;
}
