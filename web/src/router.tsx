import { createRootRoute, createRoute, createRouter, retainSearchParams } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { Debug } from "./routes/Debug";
import { Health } from "./routes/Health";
import { Projects } from "./routes/Projects";
import { SessionDetail } from "./routes/SessionDetail";
import { Sessions, SessionsEmpty } from "./routes/Sessions";
import { Tools } from "./routes/Tools";

/** Global dashboard filters live on the root so every view reflects them, and `retainSearchParams`
 *  keeps them in the URL across navigations (so e.g. a date range survives switching tabs). */
export interface RootSearch {
  since?: string;
  until?: string;
  source?: string;
}

const rootRoute = createRootRoute({
  component: Layout,
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    since: typeof search.since === "string" && search.since ? search.since : undefined,
    until: typeof search.until === "string" && search.until ? search.until : undefined,
    source: typeof search.source === "string" && search.source ? search.source : undefined,
  }),
  search: { middlewares: [retainSearchParams(["since", "until", "source"])] },
});

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: Sessions,
  validateSearch: (search: Record<string, unknown>): { project?: string; source?: string; showGenerated?: boolean } => ({
    project: typeof search.project === "string" && search.project ? search.project : undefined,
    source: typeof search.source === "string" && search.source ? search.source : undefined,
    showGenerated: search.showGenerated === true || search.showGenerated === "true" ? true : undefined,
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
  // Hidden diagnostics page — no rail link; reachable by typing /debug.
  createRoute({ getParentRoute: () => rootRoute, path: "/debug", component: Debug }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
