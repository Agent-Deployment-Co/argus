import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ClampText } from "../components/ClampText";
import { DataTable, type Column } from "../components/DataTable";
import { Dash, Skills } from "../components/pills";
import { LabelBar } from "../components/LabelBar";
import { StatCards, type Stat } from "../components/StatCards";
import { OutcomeBadge, TaskDetails, TaskPanel } from "../components/TaskPanel";
import { SessionTimeline } from "../components/SessionTimeline";
import { SessionDataCard } from "../components/SessionDataCard";
import { compactProject, dtAmPm, dur, fmt, modelFamilyColor } from "../lib/format";
import { useSessionLabelsQuery } from "../lib/labels";
import { reindexSession, setSessionHidden } from "../lib/sessions";
import { useSessionDetailQuery } from "../lib/sessions";
import { sessionTitle, type SessionsSearch } from "./Sessions";
import type { SessionToolStat } from "../types";

const toolColumns: Column<SessionToolStat>[] = [
  { id: "display", label: "Tool", sortValue: (r) => r.display, cell: (r) => r.display },
  { id: "category", label: "Category", sortValue: (r) => r.category, cell: (r) => <span className="pill">{r.category}</span> },
  { id: "interactions", label: "Interactions", num: true, sortValue: (r) => r.interactions, cell: (r) => r.interactions },
  { id: "calls", label: "Calls", num: true, sortValue: (r) => r.calls, cell: (r) => fmt(r.calls) },
  { id: "resultTokens", label: "Result tokens", num: true, sortValue: (r) => r.approxResultTokens, cell: (r) => fmt(r.approxResultTokens) },
];

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

const numOrDash = (v: number | null) => (v != null ? v : <Dash />);

// How a clicked task shows its detail. "card" expands an inline card in the list; "drawer" opens the
// side panel next to the content. Flip this to compare; the drawer (TaskPanel) is kept, just
// suppressed in "card".
const TASK_VIEW: "card" | "drawer" = "card";

// Per-task label bars are hidden for now (session-level labeling stays on). Flip to re-enable.
const SHOW_TASK_LABELS = false;

export function SessionDetail() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const detail = useSessionDetailQuery(sessionId);
  const s = detail.data;
  const [tab, setTab] = useState<"overview" | "timeline" | "details">("overview");
  // Open tasks are a set — several can be expanded at once. Card mode toggles a task in/out; drawer
  // mode (disabled) treats it as a single selection via setOpenTaskIds(new Set([id])).
  const [openTaskIds, setOpenTaskIds] = useState<Set<string>>(() => new Set());
  const onTaskClick = (id: string) =>
    setOpenTaskIds((cur) => {
      const next = new Set(cur);
      if (TASK_VIEW === "card" && next.has(id)) next.delete(id);
      else if (TASK_VIEW === "card") next.add(id);
      else return new Set([id]);
      return next;
    });

  // Open the first task by default when landing on a session (once per session, so later manual
  // toggles stick). Keyed on sessionId since the route reuses this component across sessions.
  const firstTaskId = s?.tasks?.[0]?.id ?? null;
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId && firstTaskId && openedFor.current !== sessionId) {
      setOpenTaskIds(new Set([firstTaskId]));
      openedFor.current = sessionId;
    }
  }, [sessionId, firstTaskId]);

  // Reindexing refreshes the whole session and rebuilds the server-side snapshot, so reload the page
  // once it's done — the user gets the fully updated session without a manual refresh.
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
    { label: "Interactions", value: String(s.interactions ?? 0) },
    { label: "Skills used", value: String(s.skillsUsed ?? 0) },
    { label: "Tools used", value: String(s.toolBreakdown?.length ?? 0) },
  ];

  const tasks = s.tasks ?? [];
  const allTasksOpen = tasks.length > 0 && tasks.every((t) => openTaskIds.has(t.id));
  const toggleAllTasks = () =>
    setOpenTaskIds(allTasksOpen ? new Set() : new Set(tasks.map((t) => t.id)));
  // Top 5 tools by calls for the Overview sidebar (toolBreakdown is already sorted by calls desc); the
  // rest collapse into a single "N more" row summing their calls.
  const allTools = s.toolBreakdown ?? [];
  const topTools = allTools.slice(0, 5);
  const restTools = allTools.slice(5);
  const restCalls = restTools.reduce((sum, t) => sum + t.calls, 0);
  // The drawer (disabled) shows a single task; derive it from the open set as the first open task.
  const selectedTaskId = tasks.find((t) => openTaskIds.has(t.id))?.id ?? null;
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
          {s.summary?.trim() && <ClampText text={s.summary} maxLines={2} className="session-summary" />}
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
          aria-selected={tab === "overview"}
          className={`detail-tab${tab === "overview" ? " active" : ""}`}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "timeline"}
          className={`detail-tab${tab === "timeline" ? " active" : ""}`}
          onClick={() => setTab("timeline")}
        >
          Timeline
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "details"}
          className={`detail-tab${tab === "details" ? " active" : ""}`}
          onClick={() => setTab("details")}
        >
          Details
        </button>
      </div>

      {tab === "overview" && (
        <div className="detail-tab-panel">
          <StatCards stats={cards} />

          <div className="overview-split">
            <div className="overview-main">
              <div className="section-title-row">
                <h3 className="t-subhead">Tasks <span className="muted">({tasks.length})</span></h3>
                {tasks.length > 1 && (
                  <button
                    type="button"
                    className="rail-icon-btn"
                    onClick={toggleAllTasks}
                    title={allTasksOpen ? "Collapse all tasks" : "Expand all tasks"}
                    aria-label={allTasksOpen ? "Collapse all tasks" : "Expand all tasks"}
                  >
                    {allTasksOpen ? (
                      <ChevronsDownUp size={14} strokeWidth={2} aria-hidden />
                    ) : (
                      <ChevronsUpDown size={14} strokeWidth={2} aria-hidden />
                    )}
                  </button>
                )}
              </div>
              {tasks.length > 0 ? (
                <ol className="tasks">
                  {tasks.map((task, taskIndex) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={`task-item${openTaskIds.has(task.id) ? " selected" : ""}`}
                        onClick={() => onTaskClick(task.id)}
                        aria-pressed={openTaskIds.has(task.id)}
                        aria-expanded={TASK_VIEW === "card" ? openTaskIds.has(task.id) : undefined}
                      >
                        {openTaskIds.has(task.id) ? (
                          <ChevronDown className="task-caret" size={16} strokeWidth={2} aria-hidden />
                        ) : (
                          <ChevronRight className="task-caret" size={16} strokeWidth={2} aria-hidden />
                        )}
                        <span className="task-item-desc" title={task.description}>{task.description}</span>
                        {task.outcome && <OutcomeBadge outcome={task.outcome} />}
                      </button>
                      {/* Task labels are anchored to the task's position (taskIndex === the store's task_seq). */}
                      {SHOW_TASK_LABELS && (
                        <LabelBar sessionId={s.sessionId} taskSeq={taskIndex} applied={sessionLabels?.tasks[taskIndex] ?? []} size="sm" />
                      )}
                      {TASK_VIEW === "card" && (
                        <div className={`task-card${openTaskIds.has(task.id) ? " open" : ""}`}>
                          <div className="task-card-inner">
                            <TaskDetails sessionId={s.sessionId} task={task} />
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="task-empty">{s.interpreted ? "No tasks found." : "Interpretation pending."}</p>
              )}
            </div>

            <aside className="overview-side">
              <div className="overview-block">
                <h3 className="t-subhead">Models <span className="muted">({s.models.length})</span></h3>
                <div className="overview-card chips">
                  {s.models.length ? (
                    s.models.map((m) => (
                      <span className="chip" key={m}>
                        <span className="chip-dot" style={{ background: modelFamilyColor(m) }} />
                        {m}
                      </span>
                    ))
                  ) : (
                    <Dash />
                  )}
                </div>
              </div>
              <div className="overview-block">
                <h3 className="t-subhead">Skills <span className="muted">({(s.skills ?? []).length})</span></h3>
                <div className="overview-card chips"><Skills skills={s.skills ?? []} /></div>
              </div>
              <div className="overview-block">
                <h3 className="t-subhead">Tools <span className="muted">({allTools.length})</span></h3>
                <div className="overview-card">
                  {topTools.length > 0 ? (
                    <div className="kv">
                      {topTools.map((t) => (
                        <div className="kv-row" key={t.name}>
                          <span className="kv-k" title={t.display}>{t.display}</span>
                          <span className="kv-v">{t.calls}</span>
                        </div>
                      ))}
                      {restTools.length > 0 && (
                        <div className="kv-row">
                          <button type="button" className="kv-more-link" onClick={() => setTab("details")}>
                            {restTools.length} more
                          </button>
                          <span className="kv-v">{restCalls}</span>
                        </div>
                      )}
                    </div>
                  ) : (
                    <Dash />
                  )}
                </div>
              </div>
            </aside>
          </div>
        </div>
      )}

      {tab === "timeline" && (
        <div className="detail-tab-panel">
          <SessionTimeline key={s.sessionId} sessionId={s.sessionId} />
        </div>
      )}

      {tab === "details" && (
        <div className="detail-tab-panel">
          <div className="details-row">
            <section className="details-col-narrow">
              <h3 className="t-subhead">Session Data</h3>
              <SessionDataCard sessionId={s.sessionId} enabled={tab === "details"} />
            </section>
            <section className="details-col-wide">
              <h3 className="t-subhead">Friction</h3>
              <div className="overview-card">
                <div className="kv">
                  <Row k="Interruptions" v={numOrDash(h.interruptions)} />
                  <Row k="Rejections" v={numOrDash(h.rejections)} />
                  <Row k="Compactions" v={numOrDash(h.compactions)} />
                  <Row k="Median turn" v={h.medianTurnMs != null ? dur(h.medianTurnMs) : <Dash />} />
                  <Row k="Max turn" v={h.maxTurnMs != null ? dur(h.maxTurnMs) : <Dash />} />
                  <Row k="Token growth" v={h.tokenGrowth != null ? h.tokenGrowth.toFixed(1) + "×" : <Dash />} />
                </div>
              </div>
            </section>
          </div>

          {(s.toolBreakdown?.length ?? 0) > 0 && (
            <section>
              <h3 className="t-subhead">Tools used <span className="muted">({s.toolBreakdown!.length})</span></h3>
              <DataTable columns={toolColumns} rows={s.toolBreakdown!} initialSort="calls" />
            </section>
          )}

          {s.filesTouched.length > 0 && (
            <section>
              <h3 className="t-subhead">Files touched <span className="muted">({s.filesTouched.length})</span></h3>
              <div className="overview-card">
                <ul className="file-list">
                  {s.filesTouched.slice(0, 30).map((f) => <li key={f} title={f}>{f}</li>)}
                </ul>
              </div>
            </section>
          )}

        </div>
      )}
    </div>
    {TASK_VIEW === "drawer" && selectedTask && (
      <TaskPanel
        sessionId={s.sessionId}
        task={selectedTask}
        onClose={() => setOpenTaskIds(new Set())}
        onPrev={prevTask ? () => setOpenTaskIds(new Set([prevTask.id])) : undefined}
        onNext={nextTask ? () => setOpenTaskIds(new Set([nextTask.id])) : undefined}
      />
    )}
    </>
  );
}
