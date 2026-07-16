import { dayStamp } from "../lib/format";
import { sourceLabel } from "../lib/sources";
import type { SessionListItem } from "../types";

// Home recent-sessions sketch (#270): the 10 most-recent sessions in a minimal list — title (or the
// first prompt) + a muted source · when meta line. Deliberately spare; layout still open.
export function RecentSessionsList({ sessions }: { sessions: SessionListItem[] }) {
  if (!sessions.length) return <p className="note">No sessions in this range.</p>;
  return (
    <ul className="recent-sessions">
      {sessions.map((s) => {
        const label = s.title || s.firstPrompt || "(untitled session)";
        return (
          <li key={s.sessionId} className="recent-session">
            <div className="recent-session-title" title={label}>{label}</div>
            <div className="recent-session-meta">
              <span>{sourceLabel(s.source)}</span>
              <span>· {dayStamp(s.end)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
