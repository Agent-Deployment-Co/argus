import { ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClampText } from "./ClampText";
import { CopyButton } from "./CopyButton";
import { InteractionCount } from "./pills";
import { OutcomeBadge } from "./TaskDetails";
import { dtAmPm, fmt, pluralize } from "../lib/format";
import {
  groupSecretFindingsByInteraction,
  interactionNumber,
  secretFindingKey,
  secretFindingLabel,
  type InteractionSecretFindings,
} from "../lib/secret-findings";
import { useSessionInteractionsQuery } from "../lib/sessions";
import {
  chapterKey,
  resolveTimelineFocus,
  toChapters,
  unresolvedFocusNote,
  type TimelineFocus,
} from "../lib/timeline";
import type { SecretFinding, TimelineInteraction } from "../types";

export type { TimelineFocus } from "../lib/timeline";

/** Nothing found in this turn — the shape the map returns for an interaction with no findings. */
const NO_FINDINGS: InteractionSecretFindings = { prompt: [], response: [] };

function dispositionNote(disposition: TimelineInteraction["disposition"]): string {
  if (disposition === "interrupted") return "Interrupted — no response.";
  if (disposition === "error") return "The loop errored.";
  if (disposition === "incomplete") return "No response.";
  return "(response not retained)";
}

/** The credentials the scanner found in one half of an interaction (#336). Marks the turn even when
 *  the conversation text wasn't retained — knowing which turn and which kind of credential is the
 *  point, and the text isn't needed to say it. */
function TurnSecrets({ findings }: { findings: SecretFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ol className="tl-secrets" aria-label="Possible credentials in this turn">
      {findings.map((f) => (
        <li className="tl-secret" key={secretFindingKey(f)}>
          <ShieldAlert size={12} strokeWidth={2} aria-hidden />
          <span>{secretFindingLabel(f)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The details rail for one interaction: which interaction it is, when it ran, its token/tool
 *  totals, and the per-tool breakdown. */
function Details({ it }: { it: TimelineInteraction }) {
  return (
    <aside className="tl-side">
      <div className="tl-side-head">
        <span className="tl-side-seq">Interaction {interactionNumber(it.seq)}</span>
        {it.timestampMs != null && <span className="tl-side-time">{dtAmPm(it.timestampMs)}</span>}
      </div>
      <div className="tl-side-stats">
        <div className="tl-side-stat">
          <span className="tl-side-n">{fmt(it.totalTokens)}</span>
          <span className="tl-side-label">tokens</span>
        </div>
        <div className="tl-side-stat">
          <span className="tl-side-n">{it.toolCalls}</span>
          <span className="tl-side-label">tool {pluralize(it.toolCalls, "call")}</span>
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
function InteractionCard({
  it,
  secrets,
  focused,
  ref,
}: {
  it: TimelineInteraction;
  secrets: InteractionSecretFindings;
  /** True when a link (from a credential finding) pointed here — the card is outlined so the user
   *  sees which turn they were sent to. */
  focused: boolean;
  ref?: (el: HTMLLIElement | null) => void;
}) {
  const leaking = secrets.prompt.length > 0 || secrets.response.length > 0;
  return (
    <li
      className={`tl-item${leaking ? " tl-item--secret" : ""}${focused ? " tl-item--focus" : ""}`}
      ref={ref}
    >
      <div className="tl-main">
        <div className="tl-turn tl-turn--user">
          {it.promptText && <CopyButton value={it.promptText} label="Copy prompt" />}
          <span className="tl-role">You</span>
          <TurnSecrets findings={secrets.prompt} />
          {it.promptText ? (
            <ClampText text={it.promptText} maxLines={10} className="tl-text" />
          ) : (
            <p className="tl-text muted">(prompt not retained)</p>
          )}
        </div>
        <div className="tl-turn tl-turn--agent">
          {it.responseText && <CopyButton value={it.responseText} label="Copy agent response" />}
          <span className="tl-role">
            Agent
            {it.models.length > 0 && <span className="tl-role-model"> ({it.models.join(", ")})</span>}
          </span>
          <TurnSecrets findings={secrets.response} />
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

/** The session as an interaction timeline, grouped into task chapters. Each interaction is one unit
 *  (prompt / loop details / response); prompt/response text shows only when conversation-text
 *  retention was on at index time. Turns where the scanner found a likely credential carry a marker
 *  saying what kind and (redacted) which one. */
export function SessionTimeline({
  sessionId,
  focus,
  secretFindings,
}: {
  sessionId: string;
  /** A one-shot request (from a task's timeline link, or a credential finding) to open a chapter or
   *  an interaction and scroll to it. */
  focus?: TimelineFocus | null;
  /** The session's secret-scan findings, so the timeline can mark the turns they came from. */
  secretFindings?: SecretFinding[];
}) {
  const q = useSessionInteractionsQuery(sessionId);
  // Per-chapter collapse overrides. null = the user hasn't touched anything yet, so the default below
  // applies: a session with a single task opens expanded, one with several opens collapsed.
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  // The element for the focused target (a chapter, or a single interaction card), so we can scroll it
  // into view once the tab is shown. A callback ref, because the target is a <section> for a task and
  // an <li> for an interaction.
  const focusRef = useRef<HTMLElement | null>(null);
  const setFocusEl = (el: HTMLElement | null) => {
    focusRef.current = el;
  };

  // Honor a focus request: expand the target chapter and scroll to it. Reruns when the request or the
  // data changes (the timeline may still be loading when the tab first opens).
  useEffect(() => {
    const data = q.data;
    if (!focus || !data) return;
    const chaps = toChapters(data.interactions, data.tasks);
    const target = resolveTimelineFocus(chaps, focus);
    if (!target) return;
    const key = chapterKey(target.chapterIndex);
    setCollapsed((prev) => {
      const base = prev ?? (data.tasks.length > 1 ? new Set(chaps.map((_, i) => chapterKey(i))) : new Set<string>());
      if (!base.has(key)) return prev; // already expanded (or default-open)
      const next = new Set(base);
      next.delete(key);
      return next;
    });
    const raf = requestAnimationFrame(() =>
      focusRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
    return () => cancelAnimationFrame(raf);
  }, [focus, q.data]);

  if (q.isPending) return <p className="task-empty">Loading timeline…</p>;
  if (q.isError) return <p className="task-empty">Couldn’t load the timeline.</p>;
  const data = q.data;
  if (!data || data.interactions.length === 0) {
    return <p className="task-empty">No interactions found for this session.</p>;
  }
  const chapters = toChapters(data.interactions, data.tasks);
  // Only chapter (add headers + rail) once a session has tasks. Runs of interactions with no task
  // become synthetic "No task" chapters; an un-interpreted session (no tasks at all) stays a flat list.
  const chaptered = data.tasks.length > 0;
  // More than one task → open with every chapter collapsed; a single task (or none) → expanded.
  const defaultCollapsed =
    data.tasks.length > 1 ? new Set(chapters.map((_, i) => chapterKey(i))) : new Set<string>();
  const effectiveCollapsed = collapsed ?? defaultCollapsed;
  // Where a "show me this" link points: a chapter, and for a credential finding the card inside it.
  const focusTarget = resolveTimelineFocus(chapters, focus);
  // A link that went stale (the session was indexed again under an open tab) would otherwise switch
  // tabs and silently highlight nothing, so say what happened.
  const staleFocusNote = unresolvedFocusNote(chapters, focus);
  const secretsByInteraction = groupSecretFindingsByInteraction(secretFindings ?? []);
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev ?? defaultCollapsed);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      {staleFocusNote && (
        <p className="task-empty tl-note" role="status">
          {staleFocusNote}
        </p>
      )}
      {!data.retainedText && (
        <p className="task-empty tl-note">
          Conversation text wasn’t retained for this session, so prompts and responses aren’t shown —
          the per-interaction details still are.
        </p>
      )}
      <div className="timeline">
        {chapters.map((chapter, i) => {
          const key = chapterKey(i);
          const isCollapsed = effectiveCollapsed.has(key);
          // A chapter-level focus scrolls to the chapter head; an interaction-level one scrolls to the
          // card itself, so the chapter only takes the ref when no card is named.
          const isChapterFocusTarget =
            focusTarget != null && focusTarget.chapterIndex === i && focusTarget.interactionSeq == null;
          return (
            <section
              className={`tl-chapter${isCollapsed ? " tl-chapter--collapsed" : ""}`}
              key={key}
              ref={isChapterFocusTarget ? setFocusEl : undefined}
            >
              {chaptered && (
                <button
                  type="button"
                  className={`tl-chapter-head${chapter.task ? "" : " tl-chapter-head--none"}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(key)}
                >
                  {isCollapsed ? (
                    <ChevronRight className="tl-chapter-caret" size={16} strokeWidth={2} aria-hidden />
                  ) : (
                    <ChevronDown className="tl-chapter-caret" size={16} strokeWidth={2} aria-hidden />
                  )}
                  <span className="tl-chapter-title" title={chapter.task ? chapter.task.description : undefined}>
                    {chapter.task ? chapter.task.description : "No task"}
                  </span>
                  {chapter.task && chapter.task.outcome && <OutcomeBadge outcome={chapter.task.outcome} />}
                  <InteractionCount n={chapter.items.length} className="tl-chapter-count" />
                </button>
              )}
              {!isCollapsed && (
                <ol className={`tl-cards${chaptered ? " tl-cards--chapter" : ""}`}>
                  {chapter.items.map((it) => {
                    const isCardFocusTarget = focusTarget?.interactionSeq === it.seq;
                    return (
                      <InteractionCard
                        it={it}
                        key={it.seq}
                        secrets={secretsByInteraction.get(it.seq) ?? NO_FINDINGS}
                        focused={isCardFocusTarget}
                        ref={isCardFocusTarget ? setFocusEl : undefined}
                      />
                    );
                  })}
                </ol>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
