// Read-only mode (#281): the SPA's one capability flag, read from GET /healthz (the one route
// that's always mounted, even in read-only mode — see createApp in src/api/serve.ts). Consumers hide
// edit affordances (labels, hide-session, reindex, settings, onboarding, secrets) rather than
// rendering a button that hits a route the server dropped.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchOrOffline } from "./http";

const Ctx = createContext(false);

export function ReadOnlyProvider({ children }: { children: ReactNode }) {
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOrOffline("/healthz")
      .then((res) => res.json())
      .then((body: { readOnly?: boolean }) => {
        if (!cancelled) setReadOnly(Boolean(body.readOnly));
      })
      .catch(() => {
        // Offline or malformed — stay in the (safer) read-only-off default rather than blocking render.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <Ctx.Provider value={readOnly}>{children}</Ctx.Provider>;
}

/** Whether this server is running in read-only mode. Defaults to false until /healthz answers,
 *  so on a normal (non-read-only) install there's no flash of hidden-then-shown affordances. */
export const useReadOnly = () => useContext(Ctx);
