import { fmt } from "../lib/format";
import { useSessionTaskMetrics } from "../lib/sessions";
import type { SessionRow } from "../types";

// The task shape comes straight from the snapshot (TaskFact, re-exported via SessionRow).
type Task = NonNullable<SessionRow["tasks"]>[number];

export function OutcomeBadge({ outcome }: { outcome?: string }) {
  if (!outcome) return <span className="muted">—</span>;
  return <span className={`pill task-${outcome}`}>{outcome}</span>;
}

export function FrustrationBadge({ frustration }: { frustration?: string }) {
  if (!frustration) return <span className="muted">—</span>;
  return <span className={`pill frust-${frustration}`}>{frustration}</span>;
}

/** The detail body for one task (reason text + on-demand metrics), revealed inline when a task in the
 *  Overview list is expanded. */
export function TaskDetails({ sessionId, task }: { sessionId: string; task: Task }) {
  // Metrics are fetched on demand for the whole session (not part of the snapshot) and shared with the
  // task list via React Query's cache; we pick this task's entry.
  const metricsQuery = useSessionTaskMetrics(sessionId);
  const metrics = metricsQuery.data?.[task.id];

  return (
    <div className="task-detail-body">
      {task.outcomeReason && <div className="task-detail-reason">{task.outcomeReason}</div>}

      {metricsQuery.isPending ? (
        <span className="muted">Loading…</span>
      ) : metricsQuery.isError ? (
        <span className="task-error">{(metricsQuery.error as Error).message}</span>
      ) : metrics && metrics.messages > 0 ? (
        <div className="task-metrics">
          <div className="task-metric"><span className="task-metric-n">{metrics.interactions}</span> interactions</div>
          <div className="task-metric"><span className="task-metric-n">{fmt(metrics.totalTokens)}</span> tokens</div>
          <div className="task-metric"><span className="task-metric-n">{metrics.toolCalls}</span> tool calls</div>
        </div>
      ) : (
        // Loaded, but this task has no attributed assistant messages.
        <span className="muted">No assistant activity attributed to this task.</span>
      )}
    </div>
  );
}
