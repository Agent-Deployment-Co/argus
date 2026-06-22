// Local web server for the interactive dashboard (`argus serve`). Hono exposes the analyzed
// Dashboard as a JSON API and serves the compiled React app from dist/web. This is the foundation
// the future argusd daemon will run; today it builds the dashboard on demand, narrowed by the
// /api/snapshot filter query params (since/until/project/source), collapsing concurrent identical
// builds and leaning on the client's staleTime instead of a server-side cache.
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Dashboard } from "./aggregate.ts";
import { buildDashboard, type BuildDashboardOptions, type Log } from "./dashboard-builder.ts";
import type { TranscriptSource } from "./parse.ts";
import { computeRecommendations, type Recommendation } from "./recommendations.ts";
import { reindexSession, type ReindexSessionResult } from "./parse-incremental.ts";
import { computeTaskMetrics, type TaskMetrics } from "./task-metrics.ts";
import { collectDebugInfo, type DebugInfo } from "./debug-info.ts";
import type { ResolvedTaskExtraction } from "./config.ts";
import { openStore } from "./store.ts";
import type { ParserDiagnostic, TaskFact } from "./store-contract.ts";
import type { TaskExtractionOptions } from "./task-extraction.ts";

export interface ServeOptions {
  port: number;
  /** Open the dashboard in the default browser once it's ready (macOS `open`). */
  open: boolean;
  /** What to read + how to filter when building the dashboard. */
  build: BuildDashboardOptions;
  /** Provider settings used when the session-detail Refresh action re-indexes a single session. */
  taskExtraction: TaskExtractionOptions;
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

export interface ReindexResponse {
  tasks: TaskFact[];
  diagnostics?: ParserDiagnostic[];
}

export interface SessionTaskMetricsResponse {
  /** Per-task metrics for the session, keyed by task id. Tasks with no activity are absent. */
  metrics: Record<string, TaskMetrics>;
}

/** Server-side filters parsed from the /api/snapshot query string. Each narrows the dashboard at
 *  store-read time (pushed into buildDashboard's since/until/project/source); omitted fields fall
 *  back to the serve process's base options. */
export interface SnapshotFilters {
  since?: string;
  until?: string;
  project?: string;
  source?: "all" | TranscriptSource;
}

/** Builds the snapshot for a request, narrowed by `filters`. `force` requests a fresh build
 *  (the `?refresh` seam) rather than joining an in-flight build for the same filters. */
export type SnapshotSource = (filters: SnapshotFilters, force: boolean) => Promise<Snapshot>;
export type SessionReindexer = (sessionId: string) => Promise<ReindexSessionResult>;
/** Roll up every task's metrics for a session on demand (one store pass), keyed by task id. */
export type SessionTaskMetricsReader = (sessionId: string) => Promise<Record<string, TaskMetrics>>;
/** Gather the /debug payload (settings, env, paths, store/index status). */
export type DebugInfoReader = () => Promise<DebugInfo>;

interface AppOptions {
  reindex?: SessionReindexer;
  /** Called after a successful reindex so the caller can drop its cached snapshot. */
  onStoreChanged?: () => void;
  sessionTaskMetrics?: SessionTaskMetricsReader;
  debugInfo?: DebugInfoReader;
}

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

/** The custom header the web app sends on mutating requests. A cross-origin page can't set it
 *  without a CORS preflight, which this server never approves — so requiring it blocks CSRF. */
const APP_HEADER = "x-argus-app";

/** Reject cross-site requests to a mutating route. `serve` binds to loopback, but a malicious page
 *  open in the user's browser can still POST to localhost; a bodyless POST is a CORS "simple request"
 *  that fires without a preflight, so the side effect (here: a reindex that can spawn the configured
 *  task-extraction provider over local transcripts) would happen even though the attacker can't read
 *  the response. We require a custom header the browser only lets same-origin script set, and reject
 *  on `Sec-Fetch-Site` as defense in depth. Returns a 403 Response to send, or null to proceed. */
function rejectCrossSite(c: Context): Response | null {
  // Modern browsers stamp Sec-Fetch-Site and JS can't forge it; same-origin/none are fine, anything
  // else (same-site/cross-site) is rejected outright.
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return c.json({ error: "Cross-site requests are not allowed." }, 403);
  }
  // Primary defense for any client: the same-origin-only custom header.
  if (c.req.header(APP_HEADER) !== "1") {
    return c.json({ error: "This endpoint only accepts same-origin requests from the Argus web app." }, 403);
  }
  return null;
}

const SNAPSHOT_SOURCES = new Set<string>(["all", "claude", "codex", "gemini", "cowork"]);

/** Parse the /api/snapshot filter query params, or return an error message string for a 400.
 *  Dates are passed through as YYYY-MM-DD strings (the store compares them lexically); only
 *  `source` is validated against the known set so a typo doesn't silently widen the result. */
function parseSnapshotFilters(c: Context): SnapshotFilters | string {
  const filters: SnapshotFilters = {};
  const since = c.req.query("since");
  const until = c.req.query("until");
  const project = c.req.query("project");
  const source = c.req.query("source");
  if (since) filters.since = since;
  if (until) filters.until = until;
  if (project) filters.project = project;
  if (source) {
    if (!SNAPSHOT_SOURCES.has(source)) return `Unknown source "${source}".`;
    filters.source = source as "all" | TranscriptSource;
  }
  return filters;
}

/** Build the Hono app: the JSON API plus static serving of the SPA. Pure wiring — no listening,
 *  no transcript reading — so it can be exercised directly in tests. */
export function createApp(getSnapshot: SnapshotSource, webRoot: string | null, opts: AppOptions = {}): Hono {
  const app = new Hono();

  app.get("/api/snapshot", async (c) => {
    const filters = parseSnapshotFilters(c);
    if (typeof filters === "string") return c.json({ error: filters }, 400);
    const snap = await getSnapshot(filters, c.req.query("refresh") != null);
    return c.json(snap);
  });

  // Re-index a single session: re-read its transcript from disk and refresh it in the store
  // (sessions/messages/invocations/tasks), with task processing always on. 404 if the session is
  // unknown, 422 if its transcript is no longer on disk. Provider failures come back as non-fatal
  // diagnostics — the session is still structurally refreshed.
  app.post("/api/sessions/:id/reindex", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;

    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    if (!opts.reindex) return c.json({ error: "Reindexing is unavailable in this process." }, 503);

    const result = await opts.reindex(sessionId);
    if (!result.ok) {
      return c.json({ error: result.message, diagnostics: result.diagnostics ?? [] }, result.status);
    }

    opts.onStoreChanged?.();
    return c.json({ tasks: result.tasks, diagnostics: result.diagnostics } satisfies ReindexResponse);
  });

  // Per-task metrics for a whole session, computed on demand from the messages attributed to each
  // task (not shipped in the big snapshot). One fetch backs both the task list and the detail drawer.
  app.get("/api/sessions/:id/task-metrics", async (c) => {
    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    if (!opts.sessionTaskMetrics) return c.json({ error: "Task metrics are unavailable in this process." }, 503);

    const metrics = await opts.sessionTaskMetrics(sessionId);
    return c.json({ metrics } satisfies SessionTaskMetricsResponse);
  });

  // Hidden /debug page payload: settings, environment, resolved paths, and store/index status.
  app.get("/api/debug", async (c) => {
    if (!opts.debugInfo) return c.json({ error: "Debug info is unavailable in this process." }, 503);
    return c.json(await opts.debugInfo());
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

  // No server-side snapshot cache: each request builds its filtered slice fresh. The heavy work is
  // a store read + aggregation; the client (TanStack Query) holds a short staleTime so rapid page
  // reloads don't refetch, and the in-flight map below collapses concurrent identical requests into
  // one build. `?refresh` (force) starts a fresh build rather than joining an in-flight one. This is
  // the seam a warm argusd store will later replace.
  const inFlight = new Map<string, Promise<Snapshot>>();

  const buildOptionsFor = (filters: SnapshotFilters): BuildDashboardOptions => ({
    ...opts.build,
    source: filters.source ?? opts.build.source,
    since: filters.since ?? opts.build.since,
    until: filters.until ?? opts.build.until,
    project: filters.project ?? opts.build.project,
  });

  async function snapshot(filters: SnapshotFilters, force: boolean): Promise<Snapshot> {
    const buildOpts = buildOptionsFor(filters);
    const key = JSON.stringify(buildOpts);
    if (!force) {
      const existing = inFlight.get(key);
      if (existing) return existing;
    }
    const pending = (async () => {
      const dashboard = await buildDashboard(buildOpts, log);
      return {
        dashboard,
        recommendations: computeRecommendations(dashboard),
        generatedAtMs: dashboard.generatedAtMs,
      } satisfies Snapshot;
    })();
    inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  }

  // Task extraction is always on for an explicit single-session Refresh (deliberately unlike the CLI
  // `index refresh`, which defers to the config opt-in): force `enabled` on while keeping the
  // configured provider/model. A provider explicitly set to "off" stays off.
  const reindexTaskExtraction: ResolvedTaskExtraction = { ...opts.taskExtraction, enabled: true };
  const reindex: SessionReindexer = async (sessionId) => {
    const store = await openStore();
    try {
      return await reindexSession(sessionId, { store, taskExtraction: reindexTaskExtraction });
    } finally {
      await store.close();
    }
  };

  const sessionTaskMetrics: SessionTaskMetricsReader = async (sessionId) => {
    const store = await openStore();
    try {
      const byTask = await store.readSessionTaskMessages(sessionId);
      const out: Record<string, TaskMetrics> = {};
      for (const [taskId, messages] of byTask) out[taskId] = computeTaskMetrics(messages);
      return out;
    } finally {
      await store.close();
    }
  };

  const app = createApp(snapshot, webRoot, {
    reindex,
    sessionTaskMetrics,
    debugInfo: () => collectDebugInfo({ serveReadOnly: opts.build.readOnly ?? false }),
  });

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
    // Warm the unfiltered build so the first page load is fast; failures surface on the first request.
    void snapshot({}, false).catch(() => {});
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
