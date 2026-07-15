// Read-only demo mode (#281): the SPA's one capability flag, read from GET /healthz (the one route
// that's always mounted, even in demo mode — see createApp in src/api/serve.ts). Consumers hide edit
// affordances (labels, hide-session, reindex, settings, onboarding, secrets) rather than rendering a
// button that hits a route the server dropped.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchOrOffline } from "./http";

const Ctx = createContext(false);

export function DemoModeProvider({ children }: { children: ReactNode }) {
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchOrOffline("/healthz")
      .then((res) => res.json())
      .then((body: { demo?: boolean }) => {
        if (!cancelled) setDemo(Boolean(body.demo));
      })
      .catch(() => {
        // Offline or malformed — stay in the (safer) non-demo default rather than blocking render.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <Ctx.Provider value={demo}>{children}</Ctx.Provider>;
}

/** Whether this server is running in read-only demo mode. Defaults to false until /healthz answers,
 *  so on a normal (non-demo) install there's no flash of hidden-then-shown affordances. */
export const useDemoMode = () => useContext(Ctx);
