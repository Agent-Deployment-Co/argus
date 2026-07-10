import { ChevronDown, ChevronRight, Goal } from "lucide-react";
import { useState } from "react";
import { ClampText } from "./ClampText";
import { FrustrationBadge, OutcomeBadge } from "./TaskPanel";
import { dtAmPm, fmt } from "../lib/format";
import { useSessionInteractionsQuery } from "../lib/sessions";
import type { TimelineInteraction, TimelineTask } from "../types";

function dispositionNote(disposition: TimelineInteraction["disposition"]): string {
  if (disposition === "interrupted") return "Interrupted — no response.";
  if (disposition === "error") return "The loop errored.";
  if (disposition === "incomplete") return "No response.";
  return "(response not retained)";
}

/** The details rail for one interaction: when it ran, its token/tool totals, and the per-tool
 *  breakdown. */
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

/** One interaction as a card: user prompt on top, agent response (with its model) on the bottom, and
 *  the details rail on the right. */
function InteractionCard({ it }: { it: TimelineInteraction }) {
  return (
    <li className="tl-item">
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
  );
}

interface Chapter {
  taskSeq: number | null;
  task?: TimelineTask;
  items: TimelineInteraction[];
}

/** Group interactions into task chapters, preserving order. Task membership is non-decreasing across
 *  the timeline (bookmark assignment), so consecutive interactions with the same taskSeq are one
 *  chapter; a run with no task (before the first task) becomes a headerless group. */
function toChapters(interactions: TimelineInteraction[], tasks: TimelineTask[]): Chapter[] {
  const byIndex = new Map(tasks.map((t) => [t.seq, t]));
  const chapters: Chapter[] = [];
  for (const it of interactions) {
    const last = chapters[chapters.length - 1];
    if (last && last.taskSeq === it.taskSeq) {
      last.items.push(it);
    } else {
      chapters.push({
        taskSeq: it.taskSeq,
        task: it.taskSeq != null ? byIndex.get(it.taskSeq) : undefined,
        items: [it],
      });
    }
  }
  return chapters;
}

/** The session as an interaction timeline, grouped into task chapters. Each interaction is one unit
 *  (prompt / loop details / response); prompt/response text shows only when conversation-text
 *  retention was on at index time. */
export function SessionTimeline({ sessionId }: { sessionId: string }) {
  const q = useSessionInteractionsQuery(sessionId);
  // Collapsed task chapters, keyed by chapter key. Default expanded; a header click hides its cards.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  if (q.isPending) return <p className="task-empty">Loading timeline…</p>;
  if (q.isError) return <p className="task-empty">Couldn’t load the timeline.</p>;
  const data = q.data;
  if (!data || data.interactions.length === 0) {
    return <p className="task-empty">No interactions found for this session.</p>;
  }
  const chapters = toChapters(data.interactions, data.tasks);
  return (
    <>
      {!data.retainedText && (
        <p className="task-empty tl-note">
          Conversation text wasn’t retained for this session, so prompts and responses aren’t shown —
          the per-interaction details still are.
        </p>
      )}
      <div className="timeline">
        {chapters.map((chapter, i) => {
          const key = chapter.taskSeq != null ? `task-${chapter.taskSeq}` : `untasked-${i}`;
          const isCollapsed = collapsed.has(key);
          return (
            <section className={`tl-chapter${isCollapsed ? " tl-chapter--collapsed" : ""}`} key={key}>
              {chapter.task && (
                <button
                  type="button"
                  className="tl-chapter-head"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(key)}
                >
                  {isCollapsed ? (
                    <ChevronRight className="tl-chapter-caret" size={16} strokeWidth={2} aria-hidden />
                  ) : (
                    <ChevronDown className="tl-chapter-caret" size={16} strokeWidth={2} aria-hidden />
                  )}
                  <Goal className="tl-chapter-icon" size={15} strokeWidth={2} aria-hidden />
                  <span className="tl-chapter-title" title={chapter.task.description}>
                    {chapter.task.description}
                  </span>
                  {chapter.task.outcome && <OutcomeBadge outcome={chapter.task.outcome} />}
                  {chapter.task.frustration && chapter.task.frustration !== "none" && (
                    <FrustrationBadge frustration={chapter.task.frustration} />
                  )}
                  <span className="tl-chapter-count">
                    {chapter.items.length} {chapter.items.length === 1 ? "interaction" : "interactions"}
                  </span>
                </button>
              )}
              {!isCollapsed && (
                <ol className={`tl-cards${chapter.task ? " tl-cards--task" : ""}`}>
                  {chapter.items.map((it) => (
                    <InteractionCard it={it} key={it.seq} />
                  ))}
                </ol>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
