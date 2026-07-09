import { ClampText } from "./ClampText";
import { dtAmPm, fmt } from "../lib/format";
import { useSessionInteractionsQuery } from "../lib/sessions";
import type { TimelineInteraction } from "../types";

function dispositionNote(disposition: TimelineInteraction["disposition"]): string {
  if (disposition === "interrupted") return "Interrupted — no response.";
  if (disposition === "error") return "The loop errored.";
  if (disposition === "incomplete") return "No response.";
  return "(response not retained)";
}

/** The details rail for one interaction: when it ran, its token/tool totals, the per-tool breakdown,
 *  and the models used. */
function Details({ it }: { it: TimelineInteraction }) {
  return (
    <aside className="tl-side">
      {it.timestampMs != null && <div className="tl-side-time">{dtAmPm(it.timestampMs)}</div>}
      <div className="tl-side-stats">
        <div className="tl-side-stat">
          <span className="tl-side-n">{fmt(it.totalTokens)}</span>
          <span className="tl-side-label">tokens</span>
        </div>
        <div className="tl-side-stat">
          <span className="tl-side-n">{it.toolCalls}</span>
          <span className="tl-side-label">tool {it.toolCalls === 1 ? "call" : "calls"}</span>
        </div>
      </div>
      {it.tools.length > 0 && (
        <ul className="tl-side-tools">
          {it.tools.map((t) => (
            <li className="tl-side-tool" key={t.name}>
              <span className="tl-side-tool-name" title={t.name}>
                {t.name}
              </span>
              <span className="tl-side-tool-n">{t.count}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

/** The session as an interaction timeline. Each interaction is one unit: the user prompt on top, the
 *  agent response on the bottom, and a details rail (tokens / tools / models) off to the right.
 *  Prompt/response text is present only when conversation-text retention was on at index time. */
export function SessionTimeline({ sessionId }: { sessionId: string }) {
  const q = useSessionInteractionsQuery(sessionId);
  if (q.isPending) return <p className="task-empty">Loading timeline…</p>;
  if (q.isError) return <p className="task-empty">Couldn’t load the timeline.</p>;
  const data = q.data;
  if (!data || data.interactions.length === 0) {
    return <p className="task-empty">No interactions found for this session.</p>;
  }
  return (
    <>
      {!data.retainedText && (
        <p className="task-empty tl-note">
          Conversation text wasn’t retained for this session, so prompts and responses aren’t shown —
          the per-interaction details still are.
        </p>
      )}
      <ol className="timeline">
        {data.interactions.map((it) => (
          <li className="tl-item" key={it.seq}>
            <div className="tl-main">
              <div className="tl-turn tl-turn--user">
                <span className="tl-role">You</span>
                {it.promptText ? (
                  <ClampText text={it.promptText} maxLines={10} className="tl-text" />
                ) : (
                  <p className="tl-text muted">(prompt not retained)</p>
                )}
              </div>
              <div className="tl-turn tl-turn--agent">
                <span className="tl-role">
                  Agent
                  {it.models.length > 0 && <span className="tl-role-model"> ({it.models.join(", ")})</span>}
                </span>
                {it.responseText ? (
                  <ClampText text={it.responseText} maxLines={10} className="tl-text" />
                ) : (
                  <p className="tl-text muted">{dispositionNote(it.disposition)}</p>
                )}
              </div>
            </div>
            <Details it={it} />
          </li>
        ))}
      </ol>
    </>
  );
}
