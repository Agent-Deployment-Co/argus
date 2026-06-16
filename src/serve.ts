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
  /** Install SIGINT/SIGTERM handlers and block until one fires (the standalone `argus serve`
   *  behavior). When false, the caller owns shutdown via `signal` and the returned handle. Default true. */
  installSignalHandlers?: boolean;
  /** When the caller owns signals, aborting this stops the server. */
  signal?: AbortSignal;
}

/** Control surface for a running server. `closed` resolves once it has fully shut down. */
export interface ServeHandle {
  closed: Promise<void>;
  close(): Promise<void>;
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

export async function startServer(opts: ServeOptions, log: Log): Promise<ServeHandle> {
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

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  // Resolves once the server is actually listening, rejects if it fails before binding (e.g. the port
  // is in use). Awaiting it means a bind failure throws: standalone `argus serve` exits nonzero, and
  // under `argus run` the supervisor restarts the leg with backoff — neither treats it as success.
  let resolveListening!: () => void;
  let rejectListening!: (err: Error) => void;
  const listening = new Promise<void>((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  let isListening = false;

  // Bind to loopback only. /api/snapshot exposes transcript-derived data and `serve` is documented
  // as a local-only tool; without an explicit hostname @hono/node-server listens on 0.0.0.0, which
  // would expose that data to anyone on the network.
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, (info) => {
    isListening = true;
    const url = `http://localhost:${info.port}`;
    log(`Listening on ${url} — press Ctrl-C to stop`);
    if (!webRoot) {
      log("  ! The web app isn't built yet — showing a placeholder. Run `bun run build:web` first.");
    }
    // Warm the cache so the first page load is fast; failures surface on the first request anyway.
    void snapshot(false).catch(() => {});
    if (opts.open) spawnSync("open", [url]);
    resolveListening();
  });

  server.on("error", (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (!isListening) {
      // Never bound — fail startup loudly rather than exit cleanly.
      rejectListening(new Error(`Couldn't start the web server: ${message}`));
    } else {
      // A runtime error after a successful bind — unblock so the caller shuts down (standalone) or
      // the supervisor restarts the leg (run).
      log(`! Web server error: ${message}`);
      resolveClosed();
    }
  });

  await listening;

  let closing = false;
  const close = (): Promise<void> => {
    if (!closing) {
      closing = true;
      server.close(() => resolveClosed());
    }
    return closed;
  };

  if (opts.installSignalHandlers ?? true) {
    // Standalone `argus serve`: own the signals and block until one fires.
    const shutdown = () => {
      log("Stopped.");
      void close();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await closed;
  } else if (opts.signal) {
    // Composed under `argus run`: the orchestrator owns signals; abort triggers shutdown.
    if (opts.signal.aborted) void close();
    else opts.signal.addEventListener("abort", () => void close(), { once: true });
  }

  return { closed, close };
}
