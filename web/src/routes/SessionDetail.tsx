import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dash, Skills } from "../components/pills";
import { LabelBar } from "../components/LabelBar";
import { StatCards, type Stat } from "../components/StatCards";
import { OutcomeBadge, TaskDetails, TaskPanel } from "../components/TaskPanel";
import { compactProject, dtAmPm, dur, fmt, modelFamilyColor, usd } from "../lib/format";
import { useSessionLabelsQuery } from "../lib/labels";
import { reindexSession, setSessionHidden, useSessionTaskMetrics } from "../lib/sessions";
import { useSessionDetailQuery } from "../lib/sessions";
import { sessionTitle, type SessionsSearch } from "./Sessions";

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

const numOrDash = (v: number | null) => (v != null ? v : <Dash />);

/** The session summary. When it exceeds two lines, we truncate it at a word boundary and append an
 *  ellipsis plus a "Read more" link that expands to the full text (no collapse). The cut point is
 *  found by measuring against an off-DOM clone that mirrors the paragraph's width/font and reserves
 *  room for the "… Read more" suffix, re-run on text change and viewport resize. Null prefix = the
 *  text fits two lines (or has been expanded), shown whole. */
function SessionSummary({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [prefix, setPrefix] = useState<string | null>(null);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || expanded) return;
    const measure = () => {
      const cs = getComputedStyle(host);
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.55;
      const maxHeight = lineHeight * 2 + 1;
      const clone = document.createElement("p");
      Object.assign(clone.style, {
        position: "absolute",
        left: "-9999px",
        visibility: "hidden",
        margin: "0",
        padding: "0",
        border: "0",
        whiteSpace: "normal",
        width: `${host.clientWidth}px`,
        fontStyle: cs.fontStyle,
        fontWeight: cs.fontWeight,
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
      });
      document.body.appendChild(clone);
      // The suffix the truncated text carries: an ellipsis + the "Read more" link. Non-breaking spaces
      // keep it on one line, matching the rendered (nowrap) link, so the reservation is accurate.
      const suffix = "… Read more";
      clone.textContent = text;
      if (clone.scrollHeight <= maxHeight) {
        setPrefix(null);
        clone.remove();
        return;
      }
      // Binary-search the longest character prefix that still fits two lines with the suffix appended.
      let lo = 0;
      let hi = text.length;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        clone.textContent = text.slice(0, mid) + suffix;
        if (clone.scrollHeight <= maxHeight) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      clone.remove();
      // Snap back to a word boundary so we never cut mid-word (fall back to the raw slice for a single
      // unbroken word), and drop any trailing whitespace before the ellipsis.
      const raw = text.slice(0, best);
      const atWord = raw.replace(/\s+\S*$/, "");
      setPrefix((atWord || raw).trimEnd());
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [text, expanded]);

  if (prefix !== null && !expanded) {
    return (
      <p ref={ref} className="session-summary">
        {prefix}
        {"… "}
        <button type="button" className="read-more" onClick={() => setExpanded(true)}>
          Read more
        </button>
      </p>
    );
  }
  return <p ref={ref} className="session-summary">{text}</p>;
}

// How a clicked task shows its detail. "card" expands an inline card in the list; "drawer" opens the
// side panel next to the content. Flip this to compare; the drawer (TaskPanel) is kept, just
// suppressed in "card".
const TASK_VIEW: "card" | "drawer" = "drawer";

// Per-task label bars are hidden for now (session-level labeling stays on). Flip to re-enable.
const SHOW_TASK_LABELS = false;

export function SessionDetail() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const detail = useSessionDetailQuery(sessionId);
  const s = detail.data;
  const [tab, setTab] = useState<"content" | "metrics">("content");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // Card mode toggles (click again to collapse); drawer mode just opens (it has its own close).
  const onTaskClick = (id: string) =>
    setSelectedTaskId((cur) => (TASK_VIEW === "card" && cur === id ? null : id));

  // Reindexing refreshes the whole session and rebuilds the server-side snapshot, so reload the page
  // once it's done — the user gets the fully updated session without a manual refresh.
  // Per-task metrics (tokens/cost/tools) fetched on demand for the whole session — shared with the
  // detail drawer via React Query's cache.
  const taskMetrics = useSessionTaskMetrics(sessionId ?? "").data;
  // A session's labels + its per-task labels (keyed by task position). Refreshes on every label edit
  // via React Query invalidation in the label mutation hooks.
  const sessionLabels = useSessionLabelsQuery(sessionId).data;

  const refresh = useMutation({
    mutationFn: reindexSession,
    onSuccess: () => {
      window.location.reload();
    },
  });

  // Unlike Refresh, hiding stays on this pane (the point is to see the toggle take effect on the
  // session you're looking at) — invalidate the detail query so the button flips label, and the
  // sessions list so a now-hidden session vanishes from it immediately if open elsewhere.
  const qc = useQueryClient();
  const hide = useMutation({
    mutationFn: ({ sessionId, hidden }: { sessionId: string; hidden: boolean }) =>
      setSessionHidden(sessionId, hidden),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["session", sessionId] });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  if (detail.isPending) {
    return <div className="session-empty">Loading session…</div>;
  }
  if (!s) {
    return <div className="session-empty">Session not found — it may have aged out of the current window.</div>;
  }

  const h = s.health;
  const cards: Stat[] = [
    { label: "Tokens", value: fmt(s.total) },
    { label: "Est. cost", value: usd(s.cost) },
    { label: "Interactions", value: String(s.interactions ?? 0) },
  ];

  const tools = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]);
  const tasks = s.tasks ?? [];
  const selectedTaskIndex = tasks.findIndex((t) => t.id === selectedTaskId);
  const selectedTask = selectedTaskIndex >= 0 ? tasks[selectedTaskIndex] : null;
  const prevTask = selectedTaskIndex > 0 ? tasks[selectedTaskIndex - 1] : null;
  const nextTask = selectedTaskIndex >= 0 && selectedTaskIndex < tasks.length - 1 ? tasks[selectedTaskIndex + 1] : null;
  const refreshingThisSession = refresh.isPending && refresh.variables === s.sessionId;
  const refreshError =
    !refresh.isPending && refresh.variables === s.sessionId && refresh.error instanceof Error
      ? refresh.error.message
      : null;
  const hidePending = hide.isPending && hide.variables?.sessionId === s.sessionId;
  const hideError =
    !hide.isPending && hide.variables?.sessionId === s.sessionId && hide.error instanceof Error
      ? hide.error.message
      : null;

  return (
    <>
    <div className="session-detail-inner">
      <header className="session-detail-head">
        <div className="session-detail-headline">
          <div className="session-detail-eyebrow">
            <Link to="/sessions/$sessionId" params={{ sessionId: s.sessionId }} search={(prev: SessionsSearch) => ({ ...prev, source: s.source })} className="eyebrow-link" title={`Filter to ${s.source}`}>
              {s.source}
            </Link>
            <span className="muted">·</span>
            <Link to="/sessions/$sessionId" params={{ sessionId: s.sessionId }} search={(prev: SessionsSearch) => ({ ...prev, project: s.project })} className="eyebrow-link truncate" title={`Filter to ${s.project}`}>
              {compactProject(s.project)}
            </Link>
            <span className="muted">·</span>
            <span>{dtAmPm(s.start)} for {dur(s.durationMs)}</span>
            {s.user && (<><span className="muted">·</span><span>{s.user}</span></>)}
          </div>
          <h2 className="t-title">{sessionTitle(s)}</h2>
          {s.summary?.trim() && <SessionSummary text={s.summary} />}
          <LabelBar sessionId={s.sessionId} applied={sessionLabels?.session ?? []} />
        </div>
        <div className="session-detail-actions">
          <button
            type="button"
            className="task-action"
            onClick={() => hide.mutate({ sessionId: s.sessionId, hidden: !s.isHidden })}
            disabled={hidePending}
            title={s.isHidden ? "Unhide this session" : "Hide this session from the list and search"}
          >
            {s.isHidden ? <Eye size={14} strokeWidth={1.75} aria-hidden /> : <EyeOff size={14} strokeWidth={1.75} aria-hidden />}
            <span>{s.isHidden ? "Unhide" : "Hide"}</span>
          </button>
          <button
            type="button"
            className="task-action"
            onClick={() => refresh.mutate(s.sessionId)}
            disabled={refreshingThisSession}
            title="Re-read this session's transcript from disk and update it"
          >
            <RefreshCw size={14} strokeWidth={1.75} className={refreshingThisSession ? "spin" : undefined} aria-hidden />
            <span>{refreshingThisSession ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>
      </header>

      {refreshError && <div className="task-error" role="alert">{refreshError}</div>}
      {hideError && <div className="task-error" role="alert">{hideError}</div>}

      <div className="detail-tabs" role="tablist" aria-label="Session detail views">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "content"}
          className={`detail-tab${tab === "content" ? " active" : ""}`}
          onClick={() => setTab("content")}
        >
          Content
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "metrics"}
          className={`detail-tab${tab === "metrics" ? " active" : ""}`}
          onClick={() => setTab("metrics")}
        >
          Metrics
        </button>
      </div>

      {tab === "content" ? (
        <div className="detail-tab-panel">
          <section>
            <h3 className="t-subhead">Tasks <span className="muted">({tasks.length})</span></h3>
            {tasks.length > 0 ? (
              <ol className="tasks">
                {tasks.map((task, taskIndex) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className={`task-item${task.id === selectedTaskId ? " selected" : ""}`}
                      onClick={() => onTaskClick(task.id)}
                      aria-pressed={task.id === selectedTaskId}
                      aria-expanded={TASK_VIEW === "card" ? task.id === selectedTaskId : undefined}
                    >
                      <span className="task-item-desc" title={task.description}>{task.description}</span>
                      {task.outcome && <OutcomeBadge outcome={task.outcome} />}
                      <span className="task-item-tokens">
                        {taskMetrics ? `${fmt(taskMetrics[task.id]?.totalTokens ?? 0)} tok` : ""}
                      </span>
                    </button>
                    {/* Task labels are anchored to the task's position (taskIndex === the store's task_seq). */}
                    {SHOW_TASK_LABELS && (
                      <LabelBar sessionId={s.sessionId} taskSeq={taskIndex} applied={sessionLabels?.tasks[taskIndex] ?? []} size="sm" />
                    )}
                    {TASK_VIEW === "card" && task.id === selectedTaskId && (
                      <div className="task-card">
                        <TaskDetails sessionId={s.sessionId} task={task} />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="task-empty">{s.interpreted ? "No tasks found." : "Interpretation pending."}</p>
            )}
          </section>
        </div>
      ) : (
        <div className="detail-tab-panel">
          <StatCards stats={cards} />

          <section>
            <h3 className="t-subhead">Friction</h3>
            <div className="kv">
              <Row k="Interruptions" v={numOrDash(h.interruptions)} />
              <Row k="Rejections" v={numOrDash(h.rejections)} />
              <Row k="Compactions" v={numOrDash(h.compactions)} />
              <Row k="Median turn" v={h.medianTurnMs != null ? dur(h.medianTurnMs) : <Dash />} />
              <Row k="Max turn" v={h.maxTurnMs != null ? dur(h.maxTurnMs) : <Dash />} />
              <Row k="Token growth" v={h.tokenGrowth != null ? h.tokenGrowth.toFixed(1) + "×" : <Dash />} />
            </div>
          </section>

          <section>
            <h3 className="t-subhead">Models</h3>
            {s.models.length ? (
              <div className="chips">
                {s.models.map((m) => (
                  <span className="chip" key={m}>
                    <span className="chip-dot" style={{ background: modelFamilyColor(m) }} />
                    {m}
                  </span>
                ))}
              </div>
            ) : <Dash />}
          </section>

          <section>
            <h3 className="t-subhead">Skills</h3>
            <div className="chips"><Skills skills={s.topSkills} /></div>
          </section>

          {tools.length > 0 && (
            <section>
              <h3 className="t-subhead">Tools used</h3>
              <div className="kv">
                {tools.slice(0, 12).map(([tool, count]) => <Row key={tool} k={tool} v={count} />)}
              </div>
            </section>
          )}

          {s.filesTouched.length > 0 && (
            <section>
              <h3 className="t-subhead">Files touched <span className="muted">({s.filesTouched.length})</span></h3>
              <ul className="file-list">
                {s.filesTouched.slice(0, 30).map((f) => <li key={f} title={f}>{f}</li>)}
              </ul>
            </section>
          )}

          {s.firstPrompt && (
            <section>
              <h3 className="t-subhead">Opening prompt</h3>
              <blockquote className="first-prompt">{s.firstPrompt}</blockquote>
            </section>
          )}
        </div>
      )}
    </div>
    {TASK_VIEW === "drawer" && selectedTask && (
      <TaskPanel
        sessionId={s.sessionId}
        task={selectedTask}
        onClose={() => setSelectedTaskId(null)}
        onPrev={prevTask ? () => setSelectedTaskId(prevTask.id) : undefined}
        onNext={nextTask ? () => setSelectedTaskId(nextTask.id) : undefined}
      />
    )}
    </>
  );
}
