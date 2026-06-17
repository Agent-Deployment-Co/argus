import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { Health } from "./routes/Health";
import { Projects } from "./routes/Projects";
import { SessionDetail } from "./routes/SessionDetail";
import { Sessions, SessionsEmpty } from "./routes/Sessions";
import { Tools } from "./routes/Tools";

const rootRoute = createRootRoute({ component: Layout });

const sessionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sessions", component: Sessions });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Activity }),
  createRoute({ getParentRoute: () => rootRoute, path: "/projects", component: Projects }),
  sessionsRoute.addChildren([
    createRoute({ getParentRoute: () => sessionsRoute, path: "/", component: SessionsEmpty }),
    createRoute({ getParentRoute: () => sessionsRoute, path: "$sessionId", component: SessionDetail }),
  ]),
  createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: Tools }),
  createRoute({ getParentRoute: () => rootRoute, path: "/health", component: Health }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
