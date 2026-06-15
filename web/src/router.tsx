import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { Health } from "./routes/Health";
import { Projects } from "./routes/Projects";
import { Tools } from "./routes/Tools";

const rootRoute = createRootRoute({ component: Layout });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Activity }),
  createRoute({ getParentRoute: () => rootRoute, path: "/projects", component: Projects }),
  createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: Tools }),
  createRoute({ getParentRoute: () => rootRoute, path: "/health", component: Health }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
