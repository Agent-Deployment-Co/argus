import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClampText } from "../components/ClampText";
import { DataTable, type Column } from "../components/DataTable";
import { Dash, InteractionCount, Skills } from "../components/pills";
import { Kv, KvRow } from "../components/kv";
import { InteractionsIcon } from "../lib/icons";
import { LabelBar } from "../components/LabelBar";
import { StatCards, type Stat } from "../components/StatCards";
import { OutcomeBadge, TaskDetails } from "../components/TaskDetails";
import { SessionTimeline } from "../components/SessionTimeline";
import { SessionDataCard } from "../components/SessionDataCard";
import { compactProject, dtAmPm, dur, fmt, modelFamilyColor, pluralize } from "../lib/format";
import { useSessionLabelsQuery } from "../lib/labels";
import { reindexSession, setSessionHidden } from "../lib/sessions";
import { useSessionDetailQuery, useSessionTaskMetrics } from "../lib/sessions";
import { sessionTitle, type SessionsSearch } from "./Sessions";
import type { SessionToolStat } from "../types";

const toolColumns: Column<SessionToolStat>[] = [
  { id: "display", label: "Tool", sortValue: (r) => r.display, cell: (r) => r.display },
  { id: "category", label: "Category", sortValue: (r) => r.category, cell: (r) => <span className="pill">{r.category}</span> },
  { id: "interactions", label: "Interactions", num: true, sortValue: (r) => r.interactions, cell: (r) => r.interactions },
  { id: "calls", label: "Calls", num: true, sortValue: (r) => r.calls, cell: (r) => fmt(r.calls) },
  { id: "resultTokens", label: "Result tokens", num: true, sortValue: (r) => r.approxResultTokens, cell: (r) => fmt(r.approxResultTokens) },
];

const numOrDash = (v: number | null) => (v != null ? v : <Dash />);

// Per-task label bars are hidden for now (session-level labeling stays on). Flip to re-enable.
const SHOW_TASK_LABELS = false;

export function SessionDetail() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const detail = useSessionDetailQuery(sessionId);
  const s = detail.data;
  // Per-task metrics (interaction counts for the task list's timeline links). Same query key as the
  // expanded task detail's, so React Query serves both from one request.
  const taskMetrics = useSessionTaskMetrics(sessionId ?? "").data;
  const [tab, setTab] = useState<"overview" | "timeline" | "details">("overview");
  // A one-shot request to open the Timeline tab focused on a task chapter (from a task's timeline
  // link). The nonce makes each click a fresh value so re-clicking the same task re-focuses it.
  const [timelineFocus, setTimelineFocus] = useState<{ seq: number; nonce: number } | null>(null);
  const openInTimeline = (seq: number) => {
    setTimelineFocus((prev) => ({ seq, nonce: (prev?.nonce ?? 0) + 1 }));
    setTab("timeline");
  };
  // Manual tab navigation clears any pending timeline focus so it doesn't re-fire on a later visit.
  const goToTab = (t: "overview" | "timeline" | "details") => {
    setTimelineFocus(null);
    setTab(t);
  };
  // Open tasks are a set — several can be expanded at once; clicking a task toggles it in/out.
  const [openTaskIds, setOpenTaskIds] = useState<Set<string>>(() => new Set());
  const onTaskClick = (id: string) =>
    setOpenTaskIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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
    // Tasks follow interactions (matching the session-list order); only shown once interpretation has
    // run (otherwise 0 would read as "no tasks").
    ...(s.interpreted ? [{ label: "Tasks", value: String(s.tasks?.length ?? 0) }] : []),
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
    <div className="session-detail-inner">
      <header className="session-detail-head">
        <div className="session-detail-headline">
          <div className="session-detail-eyebrow">
            <Link to="/sessions/$sessionId" params={{ sessionId: s.sessionId }} search={(prev: SessionsSearch) => ({ ...prev, source: s.source })} className="text-link" title={`Filter to ${s.source}`}>
              {s.source}
            </Link>
            <span className="muted">·</span>
            <Link to="/sessions/$sessionId" params={{ sessionId: s.sessionId }} search={(prev: SessionsSearch) => ({ ...prev, project: s.project })} className="text-link truncate" title={`Filter to ${s.project}`}>
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
          onClick={() => goToTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "timeline"}
          className={`detail-tab${tab === "timeline" ? " active" : ""}`}
          onClick={() => goToTab("timeline")}
        >
          Timeline
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "details"}
          className={`detail-tab${tab === "details" ? " active" : ""}`}
          onClick={() => goToTab("details")}
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
                  {tasks.map((task, taskIndex) => {
                    const open = openTaskIds.has(task.id);
                    const interactions = taskMetrics?.[task.id]?.interactions;
                    return (
                      <li key={task.id}>
                        <div className="task-row">
                          <button
                            type="button"
                            className={`task-item${open ? " selected" : ""}`}
                            onClick={() => onTaskClick(task.id)}
                            aria-pressed={open}
                            aria-expanded={open}
                          >
                            {open ? (
                              <ChevronDown className="task-caret" size={16} strokeWidth={2} aria-hidden />
                            ) : (
                              <ChevronRight className="task-caret" size={16} strokeWidth={2} aria-hidden />
                            )}
                            <span className="task-item-desc" title={task.description}>{task.description}</span>
                            {task.outcome && <OutcomeBadge outcome={task.outcome} />}
                          </button>
                          <button
                            type="button"
                            className="task-timeline-link"
                            onClick={() => openInTimeline(taskIndex)}
                            title="View this task in the timeline"
                            aria-label="View this task in the timeline"
                          >
                            {interactions != null ? (
                              <InteractionCount n={interactions} size={14} />
                            ) : (
                              <InteractionsIcon size={14} strokeWidth={1.75} aria-hidden />
                            )}
                          </button>
                        </div>
                        {/* Task labels are anchored to the task's position (taskIndex === the store's task_seq). */}
                        {SHOW_TASK_LABELS && (
                          <LabelBar sessionId={s.sessionId} taskSeq={taskIndex} applied={sessionLabels?.tasks[taskIndex] ?? []} size="sm" />
                        )}
                        <div className={`task-card${open ? " open" : ""}`}>
                          <div className="task-card-inner">
                            <TaskDetails sessionId={s.sessionId} task={task} />
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="overview-card">
                  <p className="task-empty">{s.interpreted ? "No tasks found." : "Interpretation pending."}</p>
                </div>
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
                          <span className="kv-v" title={`${t.calls} ${pluralize(t.calls, "call")}`}><span className="calls-x">×</span>{t.calls}</span>
                        </div>
                      ))}
                      {restTools.length > 0 && (
                        <div className="kv-row">
                          <button type="button" className="kv-more-link" onClick={() => setTab("details")}>
                            {restTools.length} more
                          </button>
                          <span className="kv-v" title={`${restCalls} ${pluralize(restCalls, "call")}`}><span className="calls-x">×</span>{restCalls}</span>
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
          <SessionTimeline key={s.sessionId} sessionId={s.sessionId} focus={timelineFocus} />
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
                <Kv>
                  <KvRow k="Interruptions" v={numOrDash(h.interruptions)} />
                  <KvRow k="Rejections" v={numOrDash(h.rejections)} />
                  <KvRow k="Compactions" v={numOrDash(h.compactions)} />
                  <KvRow k="Median turn" v={h.medianTurnMs != null ? dur(h.medianTurnMs) : <Dash />} />
                  <KvRow k="Max turn" v={h.maxTurnMs != null ? dur(h.maxTurnMs) : <Dash />} />
                  <KvRow k="Token growth" v={h.tokenGrowth != null ? h.tokenGrowth.toFixed(1) + "×" : <Dash />} />
                </Kv>
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
  );
}
