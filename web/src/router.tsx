import { createRootRoute, createRoute, createRouter, retainSearchParams } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { Debug } from "./routes/Debug";
import { Health } from "./routes/Health";
import { Projects } from "./routes/Projects";
import { SessionDetail } from "./routes/SessionDetail";
import { Sessions, SessionsEmpty } from "./routes/Sessions";
import { SettingsSurface } from "./routes/Settings";
import { Tools } from "./routes/Tools";

/** Global dashboard filters live on the root so every view reflects them, and `retainSearchParams`
 *  keeps them in the URL across navigations (so e.g. a date range survives switching tabs). */
export interface RootSearch {
  since?: string;
  until?: string;
  source?: string;
}

/** Local YYYY-MM-DD `n` days before today — the store compares message dates as local YYYY-MM-DD. */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const rootRoute = createRootRoute({
  component: Layout,
  // Default the view to the last 30 days (from = today−30, to = today) when no date is in the URL.
  // Both bounds are local YYYY-MM-DD, compared whole-day in the store (date >= from AND date <= to),
  // so the range is inclusive of every message on both the start and end day. Widen by editing the bar.
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    since: typeof search.since === "string" && search.since ? search.since : daysAgo(30),
    until: typeof search.until === "string" && search.until ? search.until : daysAgo(0),
    source: typeof search.source === "string" && search.source ? search.source : undefined,
  }),
  search: { middlewares: [retainSearchParams(["since", "until", "source"])] },
});

const SESSION_SORTS = ["recent", "tokens", "cost"] as const;

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: Sessions,
  // `source` and the date range are global (root); these are the Sessions-local refinements.
  validateSearch: (
    search: Record<string, unknown>,
  ): { project?: string; showGenerated?: boolean; sort?: (typeof SESSION_SORTS)[number]; q?: string } => ({
    project: typeof search.project === "string" && search.project ? search.project : undefined,
    showGenerated: search.showGenerated === true || search.showGenerated === "true" ? true : undefined,
    sort: SESSION_SORTS.includes(search.sort as (typeof SESSION_SORTS)[number])
      ? (search.sort as (typeof SESSION_SORTS)[number])
      : undefined,
    q: typeof search.q === "string" && search.q ? search.q : undefined,
  }),
});

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Activity }),
  createRoute({ getParentRoute: () => rootRoute, path: "/projects", component: Projects }),
  sessionsRoute.addChildren([
    createRoute({ getParentRoute: () => sessionsRoute, path: "/", component: SessionsEmpty }),
    createRoute({ getParentRoute: () => sessionsRoute, path: "$sessionId", component: SessionDetail }),
  ]),
  createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: Tools }),
  createRoute({ getParentRoute: () => rootRoute, path: "/health", component: Health }),
  // The settings take-over surface (#154). Deep-linkable per category (/settings/$category); bare
  // /settings defaults to the first category. The Layout root renders the surface full-screen for
  // these paths (outside the snapshot gate), so the route components here are placeholders.
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsSurface }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/$category", component: SettingsSurface }),
  // Hidden diagnostics page — no rail link; reachable by typing /debug.
  createRoute({ getParentRoute: () => rootRoute, path: "/debug", component: Debug }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
