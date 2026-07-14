import { CopyButton } from "./CopyButton";
import { Kv, KvRow } from "./kv";
import { fmtBytes } from "../lib/format";
import { SourceBadge } from "../lib/sources";
import { useSessionProvenanceQuery } from "../lib/sessions";

/** The Details-tab "Session Data" card: the session id plus its structural-index provenance —
 *  the main transcript (size + copy-path) and its subagent/resumed-session lineage. Fetched on demand
 *  (only rendered when the Details tab is open). */
export function SessionDataCard({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
  const q = useSessionProvenanceQuery(sessionId, enabled);
  const p = q.data;

  // The "main" transcript: the session's own top-level file, falling back to any transcript file,
  // then the first indexed file. Subagent files still surface via the lineage list below.
  const mainFile =
    p?.files.find((f) => f.sessionKind === "main") ??
    p?.files.find((f) => f.kind === "transcript") ??
    p?.files[0];
  const path = mainFile ? (mainFile.observedPath ?? mainFile.transcriptPath ?? mainFile.relativePath) : null;

  return (
    <div className="overview-card session-data">
      <Kv>
        <KvRow
          k="ID"
          v={
            <span className="kv-inline-val">
              <span className="id-text">{sessionId}</span>
              <CopyButton value={sessionId} label="Copy session ID" />
            </span>
          }
        />
        {p && <KvRow k="Source" v={<SourceBadge id={p.source} />} />}
        {mainFile && (
          <KvRow
            k="Transcript"
            v={
              <span className="kv-inline-val">
                {fmtBytes(mainFile.sizeBytes)}
                {path && <CopyButton value={path} label="Copy transcript path" />}
              </span>
            }
          />
        )}
      </Kv>

      {q.isPending ? (
        <p className="muted">Loading…</p>
      ) : q.isError ? (
        <p className="task-error">{(q.error as Error).message}</p>
      ) : !p ? (
        <p className="muted">No index data for this session.</p>
      ) : (
        <>
          {p.files.length === 0 && <p className="muted">No transcript files recorded.</p>}

          {p.parents.length > 0 && (
            <div className="session-data-lineage">
              <div className="session-data-file-head">Parent session{p.parents.length > 1 ? "s" : ""}</div>
              <ul className="session-data-ids">
                {p.parents.map((id) => <li key={id} title={id}>{id}</li>)}
              </ul>
            </div>
          )}
          {p.children.length > 0 && (
            <div className="session-data-lineage">
              <div className="session-data-file-head">Subagent session{p.children.length > 1 ? "s" : ""} ({p.children.length})</div>
              <ul className="session-data-ids">
                {p.children.map((id) => <li key={id} title={id}>{id}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
