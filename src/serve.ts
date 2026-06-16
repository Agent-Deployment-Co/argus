// Local web server for the interactive dashboard (`argus serve`). Hono exposes the analyzed
// Dashboard as a JSON API and serves the compiled React app from dist/web. This is the foundation
// the future argusd daemon will run; today it builds the dashboard on demand and caches it briefly
// so rapid page reloads don't re-read every transcript.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dashboard } from "./aggregate.ts";
import { buildDashboard, type BuildDashboardOptions, type Log } from "./dashboard-builder.ts";
import { computeRecommendations, type Recommendation } from "./recommendations.ts";

export interface ServeOptions {
  port: number;
  /** Open the dashboard in the default browser once it's ready (macOS `open`). */
  open: boolean;
  /** What to read + how to filter when building the dashboard. */
  build: BuildDashboardOptions;
}

export interface Snapshot {
  dashboard: Dashboard;
  recommendations: Recommendation[];
  generatedAtMs: number;
}

/** Builds the snapshot for a request. `force` bypasses any caching the caller layered on. */
export type SnapshotSource = (force: boolean) => Promise<Snapshot>;

/** How long a built dashboard is reused before the next request triggers a fresh read. */
const CACHE_TTL_MS = 30_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** Locate the compiled web app. Works whether we're running the bundled CLI (dist/index.js, assets
 *  at dist/web) or from source after `build:web` (src/serve.ts, assets at ../dist/web). */
function findWebRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "web"), join(here, "..", "dist", "web")];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? null;
}

/** Map a URL path to a file inside the web root, refusing anything that escapes it. */
function resolveAsset(root: string, urlPath: string): string | null {
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, rel === "/" || rel === "" ? "index.html" : rel);
  if (full !== root && !full.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

function placeholderHtml(): string {
  return `<!doctype html><meta charset="utf-8"><title>Argus</title>
<body style="font:16px/1.5 system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem">
<h1>Argus is running</h1>
<p>The web app hasn't been built yet. Build it once with <code>bun run build:web</code>, or run the
dev server with <code>bun run dev:web</code> for live-reloading development.</p>
<p>The data API is live at <a href="/api/snapshot">/api/snapshot</a>.</p></body>`;
}

/** Build the Hono app: the JSON API plus static serving of the SPA. Pure wiring — no listening,
 *  no transcript reading — so it can be exercised directly in tests. */
export function createApp(getSnapshot: SnapshotSource, webRoot: string | null): Hono {
  const app = new Hono();

  app.get("/api/snapshot", async (c) => {
    const snap = await getSnapshot(c.req.query("refresh") != null);
    return c.json(snap);
  });

  // Everything else is the single-page app. Serve the requested file when it exists, otherwise fall
  // back to index.html so client-side routes resolve on a hard refresh.
  app.get("*", (c) => {
    if (!webRoot) return c.html(placeholderHtml());
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    const asset = resolveAsset(webRoot, urlPath);
    if (asset) {
      return c.body(readFileSync(asset), 200, {
        "Content-Type": MIME[extname(asset).toLowerCase()] ?? "application/octet-stream",
      });
    }
    return c.body(readFileSync(join(webRoot, "index.html")), 200, { "Content-Type": MIME[".html"]! });
  });

  return app;
}

export async function startServer(opts: ServeOptions, log: Log): Promise<void> {
  const webRoot = findWebRoot();

  // Snapshot cache: a built dashboard is reused for CACHE_TTL_MS so reloading the page (or several
  // API calls from one page) doesn't re-read every transcript. `?refresh` forces a fresh read —
  // the seam a warm argusd store will later replace. A single in-flight build is shared.
  let cached: Snapshot | null = null;
  let cachedAt = 0;
  let inFlight: Promise<Snapshot> | null = null;

  async function snapshot(force: boolean): Promise<Snapshot> {
    if (cached && !force && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const dashboard = await buildDashboard(opts.build, log);
      const snap: Snapshot = {
        dashboard,
        recommendations: computeRecommendations(dashboard),
        generatedAtMs: dashboard.generatedAtMs,
      };
      cached = snap;
      cachedAt = Date.now();
      return snap;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  const app = createApp(snapshot, webRoot);

  await new Promise<void>((resolveClose) => {
    // Bind to loopback only. /api/snapshot exposes transcript-derived data and `serve` is documented
    // as a local-only tool; without an explicit hostname @hono/node-server listens on 0.0.0.0, which
    // would expose that data to anyone on the network.
    const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, (info) => {
      const url = `http://localhost:${info.port}`;
      log(`Listening on ${url} — press Ctrl-C to stop`);
      if (!webRoot) {
        log("  ! The web app isn't built yet — showing a placeholder. Run `bun run build:web` first.");
      }
      // Warm the cache so the first page load is fast; failures surface on the first request anyway.
      void snapshot(false).catch(() => {});
      if (opts.open) spawnSync("open", [url]);
    });

    const shutdown = () => {
      log("Stopped.");
      server.close(() => resolveClose());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
