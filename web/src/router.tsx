import { createRootRoute, createRoute, createRouter, retainSearchParams } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { Health } from "./routes/Health";
import { Projects } from "./routes/Projects";
import { SessionDetail } from "./routes/SessionDetail";
import { Sessions, SessionsEmpty } from "./routes/Sessions";
import { SettingsSurface } from "./routes/Settings";
import { Tools } from "./routes/Tools";

/** The global dashboard filters (date range + source). They live on a pathless layout route that
 *  parents only the data views — so /settings (incl. the Debug tab), which doesn't use them, stays out of scope and
 *  never carry these params in their URL. `retainSearchParams` keeps them in the URL as the user moves
 *  between the data views (so e.g. a date range survives switching tabs). */
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

const rootRoute = createRootRoute({ component: Layout });

/** Pathless layout route owning the date/source filters. Its children are the data views; settings
 *  and debug sit directly under the root, so they have no since/until/source in their URL. */
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "dashboard",
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
  getParentRoute: () => dashboardRoute,
  path: "/sessions",
  component: Sessions,
  // `source` and the date range are global (the dashboard layout route); these are the
  // Sessions-local refinements.
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
  dashboardRoute.addChildren([
    createRoute({ getParentRoute: () => dashboardRoute, path: "/", component: Activity }),
    createRoute({ getParentRoute: () => dashboardRoute, path: "/projects", component: Projects }),
    sessionsRoute.addChildren([
      createRoute({ getParentRoute: () => sessionsRoute, path: "/", component: SessionsEmpty }),
      createRoute({ getParentRoute: () => sessionsRoute, path: "$sessionId", component: SessionDetail }),
    ]),
    createRoute({ getParentRoute: () => dashboardRoute, path: "/tools", component: Tools }),
    createRoute({ getParentRoute: () => dashboardRoute, path: "/health", component: Health }),
  ]),
  // The settings take-over surface (#154). Deep-linkable per category (/settings/$category); bare
  // /settings defaults to the first category. Outside the dashboard layout route, so its URL carries
  // no date/source filters. The Layout root renders the surface full-screen, so the route components
  // here are placeholders.
  // Diagnostics live in the settings surface as the "Debug" tab (/settings/debug).
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsSurface }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/$category", component: SettingsSurface }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
