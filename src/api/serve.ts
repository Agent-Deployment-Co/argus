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
import type { Dashboard } from "../reporting/aggregate.ts";
import { ALL_SOURCES, buildSnapshot, sourcesFor, type BuildDashboardOptions } from "../reporting/dashboard-builder.ts";
import type { TranscriptSource } from "../types.ts";
import {
  buildSessionDetail,
  buildSessionList,
  type SessionListResponse,
  type SessionSort,
} from "./session-list.ts";
import type { SessionRow } from "../types.ts";
import { computeRecommendations, type Recommendation } from "./recommendations.ts";
import { reindexSession, type ReindexSessionResult } from "../indexing/pipeline.ts";
import { computeTaskMetrics, type TaskMetrics } from "./task-metrics.ts";
import { collectDebugInfo, type DebugInfo } from "./debug-info.ts";
import { loadConfig, migrateLlmFlatToProviderConfigs, resolveRetainText, type ResolvedTaskExtraction } from "../config.ts";
import { openStore } from "../store/store.ts";
import { defaultSecretStore, isSecretName, maskSecret, migrateHubKeyToSecretStore, type SecretStatus, type SecretStore } from "../secrets.ts";
import { applySetting, describeSettings, testLlmConnection, type SettingsResponse } from "./settings.ts";
import { resolveClaudeBinary } from "../llm/providers/local.ts";
import type { ParserDiagnostic, TaskFact } from "../store/store-contract.ts";
import { isLevelEnabled, logWarn, type Log } from "../logger.ts";

export interface ServeOptions {
  port: number;
  /** Open the dashboard in the default browser once it's ready (macOS `open`). */
  open: boolean;
  /** What to read + how to filter when building the dashboard. */
  build: BuildDashboardOptions;
  /** Provider settings used when the session-detail Refresh action re-indexes a single session. */
  taskExtraction: ResolvedTaskExtraction;
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

/** Parsed query for the paginated session list. Date/source narrow the store read; project/q/
 *  includeGenerated refine the human-facing list; sort/limit/offset paginate. */
export interface SessionListQuery {
  since?: string;
  until?: string;
  source?: "all" | TranscriptSource;
  project?: string;
  q?: string;
  includeGenerated: boolean;
  sort: SessionSort;
  limit: number;
  offset: number;
}

export interface SessionDetailResponse {
  session: SessionRow;
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
/** A filtered/sorted/paginated page of session list rows, backed by the store's session aggregates. */
export type SessionListReader = (query: SessionListQuery) => Promise<SessionListResponse>;
/** Full detail for one session (built on demand), or null if it has no messages / doesn't exist. */
export type SessionDetailReader = (sessionId: string) => Promise<SessionRow | null>;
/** Gather the /debug payload (settings, env, paths, store/index status). */
export type DebugInfoReader = () => Promise<DebugInfo>;

interface AppOptions {
  reindex?: SessionReindexer;
  /** Called after a successful reindex so the caller can drop its cached snapshot. */
  onStoreChanged?: () => void;
  sessionTaskMetrics?: SessionTaskMetricsReader;
  sessionList?: SessionListReader;
  sessionDetail?: SessionDetailReader;
  debugInfo?: DebugInfoReader;
  /** Secret store for the BYO-key settings endpoints. Defaults to the platform store. */
  secrets?: SecretStore;
  /** Override the `argus.json` path the settings endpoints read/write. Defaults to CONFIG_FILE;
   *  injected by tests so they never touch the real config. */
  configPath?: string;
  /** The auto-resolved `claude` binary path, used as the Claude CLI path placeholder in the settings
   *  surface. Resolved once at serve startup (off the request path — resolution can spawn a login
   *  shell) and passed in; omit it (tests, other callers) and the placeholder is simply not shown. */
  claudeBinary?: string;
  /** Server log sink. Used for explicit user actions like Refresh. */
  log?: Log;
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

/** Locate the compiled web app. Checks ARGUS_WEB_ROOT first (set by the desktop tray shell so it
 *  can point at the Tauri resource bundle), then falls back to the paths used by the standalone
 *  CLI: next to the compiled binary (dist/index.js → dist/web) or relative to the source file. */
function findWebRoot(): string | null {
  const envRoot = process.env.ARGUS_WEB_ROOT;
  if (envRoot && existsSync(join(envRoot, "index.html"))) return envRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "web"), // bundled: dist/index.js → dist/web
    join(here, "..", "..", "dist", "web"), // from source: src/api/serve.ts → repo-root/dist/web
  ];
  return candidates.find((p) => existsSync(join(p, "index.html"))) ?? null;
}

/** Find the source checkout root when running `bun run src/cli.ts ...`. Installed/compiled builds
 *  don't carry the workspace files needed by `build:web`, so they skip this and serve shipped assets. */
function findSourceRoot(): string | null {
  if (process.env.ARGUS_WEB_ROOT) return null;
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  return existsSync(join(root, "package.json")) &&
    existsSync(join(root, "web", "vite.config.ts"))
    ? root
    : null;
}

function buildWebAppIfSource(log: Log): void {
  const root = findSourceRoot();
  if (!root) return;

  log("Building web app...");
  const res = spawnSync("bun", ["run", "build:web"], {
    cwd: root,
    stdio: isLevelEnabled(log, "info") ? "inherit" : "ignore",
  });
  if (res.error) {
    throw new Error(`Couldn't build the web app: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error("Couldn't build the web app before starting the server.");
  }
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

function taskCountLabel(count: number): string {
  return `${count} task${count === 1 ? "" : "s"}`;
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

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Strip the `:port` suffix from a `Host` header to get the bare host. Handles bracketed IPv6
 *  (`[::1]:4242` → `[::1]`) and leaves a bare IPv6 literal (`::1`, which has no port) untouched —
 *  a naive `/:\d+$/` would mangle `::1` into `:`. */
function hostWithoutPort(host: string): string {
  const bracketed = host.match(/^(\[[^\]]+\])(?::\d+)?$/);
  if (bracketed) return bracketed[1]!;
  // A bare IPv6 literal contains multiple colons and carries no port — leave it as-is.
  if (host.indexOf(":") !== host.lastIndexOf(":")) return host;
  return host.replace(/:\d+$/, "");
}

/** Extra guard for the secret endpoints: require the request to be addressed to loopback. A
 *  DNS-rebinding attack points an attacker-controlled hostname at 127.0.0.1, so the request reaches
 *  this server but carries the attacker's hostname in `Host` (and `Origin`). Rejecting any non-loopback
 *  Host/Origin closes that hole — on top of `rejectCrossSite`'s CSRF defense — so a stored API key can
 *  never be written or its (masked) status read by a remote page. Returns a 403 Response, or null. */
function rejectUnsafeHost(c: Context): Response | null {
  const host = hostWithoutPort(c.req.header("host") ?? "");
  if (!LOOPBACK_HOSTS.has(host)) {
    return c.json({ error: "This endpoint is only reachable on localhost." }, 403);
  }
  const origin = c.req.header("origin");
  if (origin) {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname;
    } catch {
      return c.json({ error: "Invalid Origin." }, 403);
    }
    if (!LOOPBACK_HOSTS.has(hostname)) {
      return c.json({ error: "Cross-origin requests are not allowed." }, 403);
    }
  }
  return null;
}

const SNAPSHOT_SOURCES = new Set<string>(["all", ...ALL_SOURCES]);

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

const SESSION_SORTS = new Set<string>(["recent", "tokens", "cost"]);
const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 200;

function parseIntOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse /api/sessions query params, or return an error message string for a 400. */
function parseSessionListQuery(c: Context): SessionListQuery | string {
  const sort = c.req.query("sort") ?? "recent";
  if (!SESSION_SORTS.has(sort)) return `Unknown sort "${sort}".`;
  const source = c.req.query("source");
  if (source && !SNAPSHOT_SOURCES.has(source)) return `Unknown source "${source}".`;
  const includeGenerated = c.req.query("includeGenerated") === "true" || c.req.query("includeGenerated") === "1";
  return {
    since: c.req.query("since") || undefined,
    until: c.req.query("until") || undefined,
    source: source ? (source as "all" | TranscriptSource) : undefined,
    project: c.req.query("project") || undefined,
    q: c.req.query("q") || undefined,
    includeGenerated,
    sort: sort as SessionSort,
    limit: Math.min(MAX_SESSION_LIMIT, Math.max(1, parseIntOr(c.req.query("limit"), DEFAULT_SESSION_LIMIT))),
    offset: Math.max(0, parseIntOr(c.req.query("offset"), 0)),
  };
}

/** Build the Hono app: the JSON API plus static serving of the SPA. Pure wiring — no listening,
 *  no transcript reading — so it can be exercised directly in tests. */
export function createApp(getSnapshot: SnapshotSource, webRoot: string | null, opts: AppOptions = {}): Hono {
  const app = new Hono();

  // Cheap liveness check: no store/snapshot access, just confirms the server is answering. The
  // desktop app's front-door proxy polls this to know when a restarting sidecar is back up.
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get("/api/snapshot", async (c) => {
    const filters = parseSnapshotFilters(c);
    if (typeof filters === "string") return c.json({ error: filters }, 400);
    const snap = await getSnapshot(filters, c.req.query("refresh") != null);
    return c.json(snap);
  });

  // Paginated, filtered, sorted session list — backed by SQL session aggregates, not the bulk
  // snapshot (the full per-session array no longer ships in /api/snapshot).
  app.get("/api/sessions", async (c) => {
    if (!opts.sessionList) return c.json({ error: "Session listing is unavailable in this process." }, 503);
    const query = parseSessionListQuery(c);
    if (typeof query === "string") return c.json({ error: query }, 400);
    return c.json(await opts.sessionList(query));
  });

  // Full detail for one session, built on demand so heavy per-session content (tool/skill breakdowns,
  // files, health, tasks) never rides the bulk payload. Singular `/api/session/:id` — distinct from
  // the `/api/sessions/:id/...` action routes below.
  app.get("/api/session/:id", async (c) => {
    if (!opts.sessionDetail) return c.json({ error: "Session detail is unavailable in this process." }, 503);
    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    const session = await opts.sessionDetail(sessionId);
    if (!session) return c.json({ error: "Session not found." }, 404);
    return c.json({ session } satisfies SessionDetailResponse);
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

    opts.log?.(`Refreshing ${sessionId}: re-reading the session and rebuilding tasks...`);
    const result = await opts.reindex(sessionId);
    if (!result.ok) {
      if (opts.log) logWarn(opts.log, `Refresh failed for ${sessionId}: ${result.message}`);
      return c.json({ error: result.message, diagnostics: result.diagnostics ?? [] }, result.status);
    }

    const diagnostics = result.diagnostics ?? [];
    const issueCount = diagnostics.filter((diagnostic) => diagnostic.severity !== "info").length;
    const issueNote = issueCount ? ` with ${issueCount} issue${issueCount === 1 ? "" : "s"}` : "";
    opts.log?.(`Refreshed ${sessionId}: rebuilt ${taskCountLabel(result.tasks.length)}${issueNote}.`);
    opts.onStoreChanged?.();
    return c.json({ tasks: result.tasks, diagnostics } satisfies ReindexResponse);
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

  // Settings surface (#154): the registry-driven view of everything in `argus.json`, plus a
  // validated, atomic single-setting write. Read is open (like /api/debug — it exposes no secret
  // values; the surfaced settings carry none). The write is mutating and persists to disk, so it
  // gets the same hardening as the secret endpoints: CSRF (rejectCrossSite) + DNS-rebinding
  // (rejectUnsafeHost).
  app.get("/api/settings", (c) =>
    c.json(
      describeSettings(
        opts.configPath ? loadConfig(opts.configPath) : undefined,
        opts.claudeBinary, // resolved once at startup, not per request (resolution can block on a shell)
      ) satisfies SettingsResponse,
    ),
  );

  app.put("/api/settings/:path", async (c) => {
    const blocked = rejectCrossSite(c) ?? rejectUnsafeHost(c);
    if (blocked) return blocked;
    const path = c.req.param("path");
    let value: unknown;
    try {
      value = (await c.req.json())?.value;
    } catch {
      return c.json({ error: 'Expected a JSON body with a "value".' }, 400);
    }
    const result = applySetting(path, value, opts.configPath);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ setting: result.setting });
  });

  // BYO LLM API keys (#132). Both routes are guarded against CSRF (rejectCrossSite) and
  // DNS-rebinding (rejectUnsafeHost), accept only allowlisted secret names, and NEVER return or log
  // the raw value — GET reports masked status only, POST echoes back masked status after writing.
  const secretStore = (): SecretStore => opts.secrets ?? defaultSecretStore();

  app.get("/api/settings/secrets/:name", async (c) => {
    const blocked = rejectCrossSite(c) ?? rejectUnsafeHost(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    if (!isSecretName(name)) return c.json({ error: `Unknown secret "${name}".` }, 400);
    return c.json(await secretStore().describe(name) satisfies SecretStatus);
  });

  app.post("/api/settings/secrets/:name", async (c) => {
    const blocked = rejectCrossSite(c) ?? rejectUnsafeHost(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    if (!isSecretName(name)) return c.json({ error: `Unknown secret "${name}".` }, 400);

    let value: unknown;
    try {
      value = (await c.req.json())?.value;
    } catch {
      return c.json({ error: 'Expected a JSON body with a string "value".' }, 400);
    }
    if (typeof value !== "string" || !value.trim()) {
      return c.json({ error: 'Missing "value".' }, 400);
    }
    try {
      await secretStore().set(name, value);
    } catch {
      // Deliberately generic — never surface the value or a provider error that might echo it.
      return c.json({ error: "Couldn't save the secret." }, 500);
    }
    // Derive the masked status from the value we just wrote rather than reading it back, which on
    // macOS/Windows would launch a second `security`/PowerShell subprocess.
    return c.json({ configured: true, hint: maskSecret(value) } satisfies SecretStatus);
  });

  // Test the configured LLM provider end to end: a tiny live completion so the user can confirm their
  // setup works. Mutating-ish (outbound network / a local subprocess for claude-cli/command, and it
  // reads the stored key), so it carries the same CSRF + DNS-rebinding guards.
  app.post("/api/settings/test-connection", async (c) => {
    const blocked = rejectCrossSite(c) ?? rejectUnsafeHost(c);
    if (blocked) return blocked;
    return c.json(await testLlmConnection({ configPath: opts.configPath, secrets: secretStore() }));
  });

  // Remove a stored key (the `argus secret rm` equivalent). Same CSRF + DNS-rebinding guards; returns
  // the now-unconfigured status. Idempotent — deleting an absent key still reports not-configured.
  app.delete("/api/settings/secrets/:name", async (c) => {
    const blocked = rejectCrossSite(c) ?? rejectUnsafeHost(c);
    if (blocked) return blocked;
    const name = c.req.param("name");
    if (!isSecretName(name)) return c.json({ error: `Unknown secret "${name}".` }, 400);
    try {
      await secretStore().delete(name);
    } catch {
      return c.json({ error: "Couldn't remove the secret." }, 500);
    }
    return c.json({ configured: false } satisfies SecretStatus);
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
  buildWebAppIfSource(log);
  const webRoot = findWebRoot();

  // Move any legacy plaintext Hub key out of argus.json into the secret store, so the settings surface
  // shows it as stored and the file no longer holds it. Idempotent; a no-op once migrated. Never throws
  // (the migration guards its own keychain/file writes), so a locked keychain can't block startup.
  await migrateHubKeyToSecretStore({ log });
  // Fold any legacy flat `llm.*` values under the provider they were written for, so switching the
  // active provider in the settings UI no longer inherits the old provider's model/key-env (#154
  // review). Idempotent; a no-op once migrated. Guarded so a write failure can't block startup.
  try {
    if (migrateLlmFlatToProviderConfigs()) log("Organized LLM settings by provider in argus.json.");
  } catch (err) {
    log(`Couldn't reorganize LLM settings by provider: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve the `claude` CLI path once, here at startup — never on a request. The resolver may spawn a
  // login shell (up to a few seconds when `claude` isn't on PATH, the GUI-launch case #159 targets),
  // and spawnSync blocks the event loop, so doing it per `/api/settings` GET would stall the first
  // Settings load. Computed eagerly and passed in as the field's placeholder.
  const claudeBinary = resolveClaudeBinary();

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
      // Built from SQL GROUP BY rollups (#121): the snapshot no longer materializes every usage row.
      const dashboard = await buildSnapshot(buildOpts, log);
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

  const reindex: SessionReindexer = async (sessionId) => {
    // Honor the local text-retention opt-out (#120) on the web Refresh path: resolve it from config
    // (env > argus.json > default-on) the same way taskExtraction is resolved, and thread it through.
    // Resolved per request so a config change while serving takes effect.
    const retainText = resolveRetainText();
    // Refresh normally force-extracts tasks (deliberately unlike the CLI `index refresh`, which defers
    // to the config opt-in), keeping the configured provider/model — but only when we're retaining
    // text: with retention off we neither store the conversation nor run the model over it. A provider
    // explicitly set to "off" stays off.
    const reindexTaskExtraction: ResolvedTaskExtraction = { ...opts.taskExtraction, enabled: retainText };
    const store = await openStore();
    try {
      return await reindexSession(sessionId, { store, taskExtraction: reindexTaskExtraction, retainText });
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

  const sessionList: SessionListReader = async (query) => {
    const store = await openStore();
    try {
      const aggregates = await store.readSessionAggregates({
        sources: sourcesFor(query.source ?? opts.build.source),
        since: query.since ?? opts.build.since,
        until: query.until ?? opts.build.until,
      });
      return buildSessionList(aggregates, {
        sort: query.sort,
        limit: query.limit,
        offset: query.offset,
        project: query.project,
        q: query.q,
        includeGenerated: query.includeGenerated,
      });
    } finally {
      await store.close();
    }
  };

  const sessionDetail: SessionDetailReader = async (sessionId) => {
    const store = await openStore();
    try {
      const messages = await store.readSessionMessages(sessionId);
      if (!messages.length) return null;
      const [meta, tasks] = await Promise.all([store.readSessionMeta(sessionId), store.readSessionTasks(sessionId)]);
      return buildSessionDetail(sessionId, messages, meta, tasks);
    } finally {
      await store.close();
    }
  };

  const app = createApp(snapshot, webRoot, {
    reindex,
    sessionTaskMetrics,
    sessionList,
    sessionDetail,
    debugInfo: () => collectDebugInfo({ serveReadOnly: opts.build.readOnly ?? false }),
    secrets: defaultSecretStore(),
    claudeBinary,
    log,
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
      logWarn(log, "The web app isn't built yet. Showing a placeholder. Run `bun run build:web` first.");
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
      logWarn(log, `Web server error: ${message}`);
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
