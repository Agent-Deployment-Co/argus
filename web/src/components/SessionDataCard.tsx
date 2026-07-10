import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useSessionProvenanceQuery } from "../lib/sessions";

/** Human-readable byte size (SI-ish, base-1024). */
function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className={`kv-v${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}

/** A copy icon that writes `value` to the clipboard, flipping to a check briefly. `label` is the
 *  tooltip / accessible name (e.g. "Copy session ID", "Copy transcript path"). */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-path-btn"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // Clipboard API unavailable (e.g. non-secure context) — silently no-op.
        }
      }}
    >
      {copied ? <Check size={13} strokeWidth={1.75} aria-hidden /> : <Copy size={13} strokeWidth={1.75} aria-hidden />}
    </button>
  );
}

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
      <div className="kv">
        <Row
          k="ID"
          v={
            <span className="transcript-val">
              <span className="id-text">{sessionId}</span>
              <CopyButton value={sessionId} label="Copy session ID" />
            </span>
          }
        />
        {p && <Row k="Source" v={p.source} />}
        {mainFile && (
          <Row
            k="Transcript"
            v={
              <span className="transcript-val">
                {fmtBytes(mainFile.sizeBytes)}
                {path && <CopyButton value={path} label="Copy transcript path" />}
              </span>
            }
          />
        )}
      </div>

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
