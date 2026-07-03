import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { dtAmPm, fmt, usd } from "../lib/format";
import { useSessionTaskMetrics } from "../lib/snapshot";
import type { SessionRow } from "../types";

// The task shape comes straight from the snapshot (TaskFact, re-exported via SessionRow).
type Task = NonNullable<SessionRow["tasks"]>[number];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-panel-field">
      <div className="t-overline">{label}</div>
      <div className="task-panel-value">{children}</div>
    </div>
  );
}

export function OutcomeBadge({ outcome }: { outcome?: string }) {
  if (!outcome) return <span className="muted">—</span>;
  return <span className={`pill task-${outcome}`}>{outcome}</span>;
}

function FrustrationBadge({ frustration }: { frustration?: string }) {
  if (!frustration) return <span className="muted">—</span>;
  return <span className={`pill frust-${frustration}`}>{frustration}</span>;
}

/** The full detail body for one task (description, outcome, signals, reason, on-demand metrics).
 *  Shared by the inline side panel (TaskPanel) and the inline expanding card (see SessionDetail). */
export function TaskDetails({ sessionId, task }: { sessionId: string; task: Task }) {
  // Metrics are fetched on demand for the whole session (not part of the snapshot) and shared with the
  // task list via React Query's cache; we pick this task's entry.
  const metricsQuery = useSessionTaskMetrics(sessionId);
  const metrics = metricsQuery.data?.[task.id];
  const toolEntries = metrics ? Object.entries(metrics.toolCounts) : [];

  return (
    <div className="task-panel-body">
      <Field label="Description">
        <div className="task-panel-desc">{task.description}</div>
      </Field>

      {task.timestampMs != null && <Field label="When">{dtAmPm(task.timestampMs)}</Field>}

      <Field label="Outcome">
        <OutcomeBadge outcome={task.outcome} />
      </Field>

      <Field label="Frustration">
        <FrustrationBadge frustration={task.frustration} />
      </Field>

      {task.signals && task.signals.length > 0 && (
        <Field label="Signals">
          <div className="chips">
            {task.signals.map((sig, i) => (
              <span key={i} className="pill">{sig}</span>
            ))}
          </div>
        </Field>
      )}

      {task.outcomeReason && <Field label="Reason">{task.outcomeReason}</Field>}

      <Field label="Activity">
        {metricsQuery.isPending ? (
          <span className="muted">Loading…</span>
        ) : metricsQuery.isError ? (
          <span className="task-error">{(metricsQuery.error as Error).message}</span>
        ) : metrics && metrics.messages > 0 ? (
          <div className="task-metrics">
            <div className="task-metric"><span className="task-metric-n">{fmt(metrics.totalTokens)}</span> tokens</div>
            <div className="task-metric"><span className="task-metric-n">{usd(metrics.cost)}</span> est. cost</div>
            <div className="task-metric"><span className="task-metric-n">{metrics.toolCalls}</span> tool calls</div>
            <div className="task-metric"><span className="task-metric-n">{metrics.messages}</span> messages</div>
          </div>
        ) : (
          // Loaded, but this task has no attributed assistant messages.
          <span className="muted">No assistant activity attributed to this task.</span>
        )}
      </Field>

      {toolEntries.length > 0 && (
        <Field label="Tools">
          <div className="kv">
            {toolEntries.map(([name, count]) => (
              <div className="kv-row" key={name}>
                <span className="kv-k">{name}</span>
                <span className="kv-v">{count}</span>
              </div>
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}

/** Inline side panel with the full detail for a single task. It lays out next to the session
 *  content (see .session-detail in styles.css), which shrinks to make room — not an overlay.
 *  onPrev/onNext are omitted (rather than passed as no-ops) when there's no adjacent task, which
 *  disables the corresponding nav button. The parent keeps its own task-list selection in sync
 *  since navigating here just calls back into the same setSelectedTaskId it uses for clicks. */
export function TaskPanel({
  sessionId,
  task,
  onClose,
  onPrev,
  onNext,
}: {
  sessionId: string;
  task: Task;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  // Stay mounted while the slide-out plays; the parent unmounts us once it finishes.
  const [closing, setClosing] = useState(false);
  const requestClose = () => setClosing(true);

  // If a close was mid-animation and the user picks a different task (a list row, or a prev/next
  // chevron) instead of letting it finish, cancel the close — otherwise the stale `closing` flag
  // fires onAnimationEnd and yanks the panel shut right after the user asked to see the new task.
  useEffect(() => {
    setClosing(false);
  }, [task.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      className={`task-panel${closing ? " closing" : ""}`}
      aria-label="Task details"
      onAnimationEnd={(e) => {
        // Only react to the panel's own slide animation, and only when sliding out.
        if (e.target === e.currentTarget && closing) onClose();
      }}
    >
      <header className="task-panel-head">
        <h3 className="t-subhead">Task details</h3>
        <div className="task-panel-nav">
          <div className="task-panel-nav-group">
            <button type="button" className="rail-icon-btn" onClick={onPrev} disabled={!onPrev} aria-label="Previous task">
              <ChevronLeft size={16} strokeWidth={1.75} />
            </button>
            <button type="button" className="rail-icon-btn" onClick={onNext} disabled={!onNext} aria-label="Next task">
              <ChevronRight size={16} strokeWidth={1.75} />
            </button>
          </div>
          <button type="button" className="rail-icon-btn task-panel-close" onClick={requestClose} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
      </header>

      <TaskDetails sessionId={sessionId} task={task} />
    </aside>
  );
}
