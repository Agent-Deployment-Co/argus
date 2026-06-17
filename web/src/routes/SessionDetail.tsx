import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ListTodo, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Dash, OutcomeCell, Skills } from "../components/pills";
import { StatCards, type Stat } from "../components/StatCards";
import { compactProject, dtAmPm, dur, fmt, modelFamilyColor, usd } from "../lib/format";
import { extractSessionTasks, SNAPSHOT_QUERY_KEY, useSnapshot } from "../lib/snapshot";
import type { Snapshot } from "../types";
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

export function SessionDetail() {
  const { dashboard: d } = useSnapshot();
  const queryClient = useQueryClient();
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const s = d.sessions.find((x) => x.sessionId === sessionId);

  const extractTasks = useMutation({
    mutationFn: extractSessionTasks,
    onSuccess: (data, extractedSessionId) => {
      queryClient.setQueryData<Snapshot>(SNAPSHOT_QUERY_KEY, (snap) => {
        if (!snap) return snap;
        return {
          ...snap,
          dashboard: {
            ...snap.dashboard,
            sessions: snap.dashboard.sessions.map((session) =>
              session.sessionId === extractedSessionId ? { ...session, tasks: data.tasks } : session,
            ),
          },
        };
      });
      void queryClient.invalidateQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    },
  });

  if (!s) {
    return <div className="session-empty">Session not found — it may have aged out of the current window.</div>;
  }

  const h = s.health;
  const cards: Stat[] = [
    { label: "Tokens", value: fmt(s.total) },
    { label: "Est. cost", value: usd(s.cost) },
    { label: "Messages", value: String(s.messages) },
    { label: "User messages", value: s.userMessages != null ? String(s.userMessages) : "—" },
    { label: "Duration", value: dur(s.durationMs) },
    { label: "Turns", value: h.turns != null ? String(h.turns) : "—" },
  ];

  const tools = Object.entries(s.toolCounts).sort((a, b) => b[1] - a[1]);
  const stops = h.stopReasons ? Object.entries(h.stopReasons).sort((a, b) => b[1] - a[1]) : [];
  const tasks = s.tasks ?? [];
  const extractingThisSession = extractTasks.isPending && extractTasks.variables === s.sessionId;
  const extractionError =
    !extractTasks.isPending && extractTasks.variables === s.sessionId && extractTasks.error instanceof Error
      ? extractTasks.error.message
      : null;

  return (
    <div className="session-detail-inner">
      <header className="session-detail-head">
        <div className="session-detail-eyebrow">
          <Link to="/sessions/$sessionId" params={{ sessionId: s.sessionId }} search={(prev: SessionsSearch) => ({ ...prev, source: s.source })} className="eyebrow-link" title={`Filter to ${s.source}`}>
            {s.source}
          </Link>
          <span className="muted">·</span>
          <Link to="/sessions/$sessionId" params={{ sessionId: s.sessionId }} search={(prev: SessionsSearch) => ({ ...prev, project: s.project })} className="eyebrow-link truncate" title={`Filter to ${s.project}`}>
            {compactProject(s.project)}
          </Link>
          {s.user && (<><span className="muted">·</span><span>{s.user}</span></>)}
          <span className="muted">·</span>
          <code className="session-id">{s.sessionId}</code>
        </div>
        <h2 className="session-detail-title">{sessionTitle(s)}</h2>
        <div className="session-detail-range">{dtAmPm(s.start)} → {dtAmPm(s.end)}</div>
      </header>

      <StatCards stats={cards} />

      <section>
        <div className="section-title-row">
          <h3>Tasks <span className="muted">({tasks.length})</span></h3>
          <button
            type="button"
            className="task-action"
            onClick={() => extractTasks.mutate(s.sessionId)}
            disabled={extractingThisSession}
          >
            {tasks.length ? <RefreshCw size={14} strokeWidth={1.75} aria-hidden /> : <ListTodo size={14} strokeWidth={1.75} aria-hidden />}
            <span>{extractingThisSession ? "Extracting..." : tasks.length ? "Refresh tasks" : "Extract tasks"}</span>
          </button>
        </div>
        {extractionError && <div className="task-error" role="alert">{extractionError}</div>}
        {tasks.length > 0 ? (
          <ol className="tasks">
            {tasks.map((task) => (
              <li key={task.id}>
                <div className="task-text">{task.description}</div>
                {task.timestampMs != null && (
                  <div className="task-meta">{dtAmPm(task.timestampMs)}</div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="task-empty">No tasks yet.</p>
        )}
      </section>

      <section>
        <h3>Outcome &amp; friction</h3>
        <div className="kv">
          <Row k="Outcome" v={<OutcomeCell outcome={h.outcome} />} />
          <Row k="Interruptions" v={numOrDash(h.interruptions)} />
          <Row k="Rejections" v={numOrDash(h.rejections)} />
          <Row k="Compactions" v={numOrDash(h.compactions)} />
          <Row k="Median turn" v={h.medianTurnMs != null ? dur(h.medianTurnMs) : <Dash />} />
          <Row k="Max turn" v={h.maxTurnMs != null ? dur(h.maxTurnMs) : <Dash />} />
          <Row k="Token growth" v={h.tokenGrowth != null ? h.tokenGrowth.toFixed(1) + "×" : <Dash />} />
        </div>
      </section>

      <section>
        <h3>Models</h3>
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
        <h3>Skills</h3>
        <div className="chips"><Skills skills={s.topSkills} /></div>
      </section>

      {stops.length > 0 && (
        <section>
          <h3>Stop reasons</h3>
          <div className="kv">
            {stops.map(([reason, count]) => <Row key={reason} k={reason} v={count} />)}
          </div>
        </section>
      )}

      {tools.length > 0 && (
        <section>
          <h3>Tools used</h3>
          <div className="kv">
            {tools.slice(0, 12).map(([tool, count]) => <Row key={tool} k={tool} v={count} />)}
          </div>
        </section>
      )}

      {s.filesTouched.length > 0 && (
        <section>
          <h3>Files touched <span className="muted">({s.filesTouched.length})</span></h3>
          <ul className="file-list">
            {s.filesTouched.slice(0, 30).map((f) => <li key={f} title={f}>{f}</li>)}
          </ul>
        </section>
      )}

      {s.firstPrompt && (
        <section>
          <h3>Opening prompt</h3>
          <blockquote className="first-prompt">{s.firstPrompt}</blockquote>
        </section>
      )}
    </div>
  );
}
