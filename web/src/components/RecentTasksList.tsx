import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { RecentTask } from "../types";
import { OutcomeBadge, TaskDetails } from "./TaskDetails";

// Home recent-tasks sketch (#270): up to 10 most-recent tasks, laid out and expanded exactly like the
// session-detail task list — the same `.tasks` markup + OutcomeBadge + TaskDetails, minus the
// timeline link (there's no timeline here). Rendered bare (no Panel) so it fills its column under a
// "Tasks" eyebrow. A task id can repeat across sessions, so keys/open-state are (session, id).
export function RecentTasksList({ tasks }: { tasks: RecentTask[] }) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  if (!tasks.length) return <p className="note">No tasks in this range.</p>;

  return (
    <ol className="tasks">
      {tasks.map((t) => {
        const key = `${t.sessionId}:${t.id}`;
        const open = openKeys.has(key);
        return (
          <li key={key}>
            <div className="task-row">
              <button
                type="button"
                className={`task-item${open ? " selected" : ""}`}
                onClick={() => toggle(key)}
                aria-pressed={open}
                aria-expanded={open}
              >
                {open ? (
                  <ChevronDown className="task-caret" size={16} strokeWidth={2} aria-hidden />
                ) : (
                  <ChevronRight className="task-caret" size={16} strokeWidth={2} aria-hidden />
                )}
                <span className="task-item-desc" title={t.description}>{t.description || "(no description)"}</span>
                {t.outcome && <OutcomeBadge outcome={t.outcome} />}
              </button>
            </div>
            <div className={`task-card${open ? " open" : ""}`}>
              <div className="task-card-inner">
                <TaskDetails sessionId={t.sessionId} task={t} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
