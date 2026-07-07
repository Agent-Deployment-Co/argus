import { useCallback, useEffect, useState } from "react";

/** Client-side-only "archived" set for the /sessions-inbox prototype (#sessions-inbox). Distinct from
 *  the store's `resolved_sessions.archived` flag (a session whose transcript aged off disk) — this is
 *  a purely local, reversible Gmail-style archive action with no server round-trip, since the inbox
 *  is a testing bed for a future /sessions redesign, not a shipped feature. */
const KEY = "argus-inbox-archived";

function readArchived(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function writeArchived(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Best-effort; a full/blocked localStorage just means archiving doesn't persist across reloads.
  }
}

export function inboxKey(source: string, sessionId: string): string {
  return `${source}:${sessionId}`;
}

export function useInboxArchive() {
  const [archived, setArchived] = useState<Set<string>>(readArchived);

  useEffect(() => writeArchived(archived), [archived]);

  const archive = useCallback((key: string) => {
    setArchived((prev) => new Set(prev).add(key));
  }, []);
  const unarchive = useCallback((key: string) => {
    setArchived((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  return { archived, archive, unarchive };
}
