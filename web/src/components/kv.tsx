import type { ReactNode } from "react";

/** A key/value grid (the `.kv` layout). Wrap `KvRow`s in it. */
export function Kv({ children }: { children: ReactNode }) {
  return <div className="kv">{children}</div>;
}

/** One key/value row in a `Kv` grid. `mono` renders the value in a monospace, wrapping style
 *  (paths, ids). Shared by the Details-tab friction card and the Session Data card. */
export function KvRow({ k, v, mono }: { k: ReactNode; v: ReactNode; mono?: boolean }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className={`kv-v${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}
