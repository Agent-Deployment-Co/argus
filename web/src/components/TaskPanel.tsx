import { X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { dtAmPm, fmt, usd } from "../lib/format";
import { useSessionTaskMetrics } from "../lib/snapshot";
import type { SessionRow } from "../types";

// The task shape comes straight from the snapshot (TaskFact, re-exported via SessionRow).
type Task = NonNullable<SessionRow["tasks"]>[number];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-panel-field">
      <div className="task-panel-label">{label}</div>
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

/** Right-side drawer with the full detail for a single task. Rough first pass for #90. */
export function TaskPanel({ sessionId, task, onClose }: { sessionId: string; task: Task; onClose: () => void }) {
  // Stay mounted while the slide-out plays; the parent unmounts us once it finishes.
  const [closing, setClosing] = useState(false);
  const requestClose = () => setClosing(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Metrics are fetched on demand for the whole session (not part of the snapshot) and shared with the
  // task list via React Query's cache; we pick this task's entry.
  const metricsQuery = useSessionTaskMetrics(sessionId);
  const metrics = metricsQuery.data?.[task.id];
  const toolEntries = metrics ? Object.entries(metrics.toolCounts) : [];

  return (
    <>
      <div className={`task-panel-backdrop${closing ? " closing" : ""}`} onClick={requestClose} aria-hidden />
      <aside
        className={`task-panel${closing ? " closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Task details"
        onAnimationEnd={(e) => {
          // Only react to the panel's own slide animation, and only when sliding out.
          if (e.target === e.currentTarget && closing) onClose();
        }}
      >
        <header className="task-panel-head">
          <h3>Task details</h3>
          <button type="button" className="rail-icon-btn task-panel-close" onClick={requestClose} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

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
      </aside>
    </>
  );
}
