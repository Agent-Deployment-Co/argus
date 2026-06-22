import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { dtAmPm } from "../lib/format";
import { fetchDebugInfo } from "../lib/snapshot";

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}

function Bool({ value }: { value: boolean }) {
  return <span className={`pill ${value ? "task-success" : "task-failure"}`}>{value ? "yes" : "no"}</span>;
}

function bytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function Debug() {
  const { data, isPending, isError, error } = useQuery({ queryKey: ["debug"], queryFn: fetchDebugInfo });

  if (isPending) return <div className="center-state">Loading debug info…</div>;
  if (isError) return <div className="center-state">Couldn't load debug info: {(error as Error).message}</div>;

  const d = data;
  const schemaMismatch = d.store.schemaVersion != null && d.store.schemaVersion !== d.store.expectedSchemaVersion;

  return (
    <div className="debug">
      <header className="debug-head">
        <h2>Debug</h2>
        <span className="muted">generated {dtAmPm(d.generatedAtMs)}</span>
      </header>

      <section>
        <h3>Version &amp; runtime</h3>
        <div className="kv">
          <Row k="Argus version" v={d.version.argus} />
          <Row k="Store schema (expected)" v={d.version.storeSchema} />
          <Row k="Runtime" v={d.runtime.runtime} />
          <Row k="Platform" v={`${d.runtime.platform} / ${d.runtime.arch}`} />
          <Row k="PID" v={d.runtime.pid} />
          <Row k="Uptime" v={`${d.runtime.uptimeSec}s`} />
          <Row k="Working dir" v={<code>{d.runtime.cwd}</code>} />
          <Row k="Serve read-only" v={<Bool value={d.runtime.serveReadOnly} />} />
        </div>
      </section>

      <section>
        <h3>Store &amp; index</h3>
        {d.store.error && <div className="task-error" role="alert">{d.store.error}</div>}
        <div className="kv">
          <Row k="Store path" v={<code>{d.store.path}</code>} />
          <Row k="Exists" v={<Bool value={d.store.exists} />} />
          <Row k="Size" v={bytes(d.store.sizeBytes)} />
          <Row
            k="Schema version"
            v={
              <span className={schemaMismatch ? "task-error" : undefined}>
                {d.store.schemaVersion ?? "—"}
                {schemaMismatch ? ` (expected ${d.store.expectedSchemaVersion})` : ""}
              </span>
            }
          />
          <Row k="Sessions" v={d.store.sessions ?? "—"} />
          <Row k="Messages" v={d.store.messages ?? "—"} />
          <Row k="Tasks" v={d.store.tasks ?? "—"} />
          <Row k="Messages attributed to a task" v={d.store.messagesWithTask ?? "—"} />
        </div>

        {d.store.sources.length > 0 && (
          <table className="debug-table">
            <thead>
              <tr><th>Source</th><th>Sessions</th><th>Archived</th><th>Last sync</th><th>Up to date</th></tr>
            </thead>
            <tbody>
              {d.store.sources.map((s) => (
                <tr key={s.source}>
                  <td>{s.source}</td>
                  <td>{s.sessionCount}</td>
                  <td>{s.archivedCount}</td>
                  <td>{s.lastSyncAtMs != null ? dtAmPm(s.lastSyncAtMs) : "—"}</td>
                  <td><Bool value={s.upToDate} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Paths</h3>
        <table className="debug-table">
          <thead><tr><th>Name</th><th>Path</th><th>Exists</th></tr></thead>
          <tbody>
            {d.paths.map((p) => (
              <tr key={p.name}>
                <td>{p.name}</td>
                <td><code>{p.path}</code></td>
                <td><Bool value={p.exists} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Environment</h3>
        <table className="debug-table">
          <thead><tr><th>Variable</th><th>Value</th></tr></thead>
          <tbody>
            {d.env.map((e) => (
              <tr key={e.name}>
                <td>{e.name}</td>
                <td>{e.value != null ? <code>{e.value}</code> : <span className="muted">(unset)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Task extraction</h3>
        <div className="kv">
          <Row k="Enabled" v={<Bool value={d.taskExtraction.enabled} />} />
          <Row k="Provider" v={d.taskExtraction.provider} />
          <Row k="Model" v={d.taskExtraction.model ?? <span className="muted">(default)</span>} />
        </div>
      </section>

      <section>
        <h3>Settings (argus.json)</h3>
        <pre className="debug-json">{JSON.stringify(d.config, null, 2)}</pre>
      </section>
    </div>
  );
}
