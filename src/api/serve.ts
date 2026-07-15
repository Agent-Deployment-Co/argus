// Local web server for the interactive dashboard (`argus serve`). Hono exposes each dashboard view as
// its own small JSON API (the per-view endpoints under /api/*) and serves the compiled React app from
// dist/web. Every view reads exactly what it needs from argus.db on demand, narrowed by the shared
// filter query params (since/until/project/source); there is no server-side cache and no monolithic
// snapshot build. The `index` leg of `argus run` is the sole writer, so serve's reads are read-only.
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_SOURCES, sourcesFor, type BuildDashboardOptions } from "../reporting/dashboard-builder.ts";
import { loadPlugins } from "../reporting/inventory.ts";
import { unpricedModels } from "../pricing.ts";
import type { ResolvedQuery, SessionSearchMatch, Store } from "../store/store-contract.ts";
import type { TranscriptSource } from "../types.ts";
import {
  buildSessionsBySource,
  buildUsageByModel,
  buildUsageByProject,
  buildUsageBySource,
  buildUsageBySourceDaily,
  buildUsageDaily,
  type SessionsBySourceResponse,
  type UsageByModelResponse,
  type UsageByProjectResponse,
  type UsageBySourceDailyResponse,
  type UsageBySourceResponse,
  type UsageDailyResponse,
} from "./usage.ts";
import {
  buildByMcpServer,
  buildByTool,
  buildByToolCategory,
  buildHeaviestResults,
  buildSkills,
  type ByMcpServerResponse,
  type ByToolCategoryResponse,
  type ByToolResponse,
  foldBySkill,
  type HeaviestResultsResponse,
  type SkillsResponse,
} from "./tools.ts";
import { buildPlugins, type PluginsResponse } from "./plugins.ts";
import { buildHealth, type HealthResponse } from "./health.ts";
import {
  buildSessionDetail,
  buildSessionList,
  type SessionListResponse,
  type SessionSort,
} from "./session-list.ts";
import type { PluginRow, SessionRow } from "../types.ts";
import { computeRecommendations, type Recommendation } from "./recommendations.ts";
import { reindexSession, type ReindexSessionResult } from "../indexing/pipeline.ts";
import { computeTaskMetrics, type TaskMetrics } from "./task-metrics.ts";
import { buildSessionInteractions, type SessionInteractionsResponse } from "./session-interactions.ts";
import { collectDebugInfo, type DebugInfo } from "./debug-info.ts";
import { CONFIG_FILE } from "../paths.ts";
import { loadConfig, migrateLlmFlatToProviderConfigs, migrateTaskExtractionToSessionInterpretation, resolveRetainText, type ArgusConfig, type ResolvedSessionInterpretation } from "../config.ts";
import { LabelError, openStore } from "../store/store.ts";
import type {
  AppliedLabel,
  LabelAppliedBy,
  LabelFilterMode,
  LabelRecord,
  LabelTarget,
  SessionLabels,
} from "../store/store-contract.ts";
import { defaultSecretStore, isSecretName, maskSecret, migrateHubKeyToSecretStore, type SecretStatus, type SecretStore } from "../secrets.ts";
import { applyOnboardingCompleted, applySetting, describeSettings, testLlmConnection, type SettingsResponse } from "./settings.ts";
import { resolveClaudeBinary } from "../llm/providers/local.ts";
import type { ParserDiagnostic, SessionProvenance, TaskFact } from "../store/store-contract.ts";
import { isLevelEnabled, logger, logWarn, normalizeLogLevel, type Log } from "../logger.ts";

export interface ServeOptions {
  port: number;
  /** Open the dashboard in the default browser once it's ready (macOS `open`). */
  open: boolean;
  /** What to read + how to filter when building the dashboard. */
  build: BuildDashboardOptions;
  /** Provider settings used when the session-detail Refresh action re-indexes a single session. */
  taskExtraction: ResolvedSessionInterpretation;
  /** Install SIGINT/SIGTERM handlers and block until one fires (the standalone `argus serve`
   *  behavior). When false, the caller owns shutdown via `signal` and the returned handle. Default true. */
  installSignalHandlers?: boolean;
  /** When the caller owns signals, aborting this stops the server. */
  signal?: AbortSignal;
  /** Override the `argus.json` path. Defaults to CONFIG_FILE; injected by tests so they never touch
   *  the real config. */
  configPath?: string;
}

/** Control surface for a running server. `closed` resolves once it has fully shut down. */
export interface ServeHandle {
  closed: Promise<void>;
  close(): Promise<void>;
}

/** GET /api/recommendations payload. */
export interface RecommendationsResponse {
  recommendations: Recommendation[];
}

export interface ReindexResponse {
  tasks: TaskFact[];
  diagnostics?: ParserDiagnostic[];
}

export interface SessionTaskMetricsResponse {
  /** Per-task metrics for the session, keyed by task id. Tasks with no activity are absent. */
  metrics: Record<string, TaskMetrics>;
}

/** Parsed query for the paginated session list. Date/source narrow the store read; project/q/file/
 *  includeGenerated refine the human-facing list; sort/limit/offset paginate. `q`/`file` (#155) run a
 *  store-side search (conversation/task text FTS, file-path substring) before the aggregate read. */
export interface SessionListQuery {
  since?: string;
  until?: string;
  source?: "all" | TranscriptSource;
  project?: string;
  q?: string;
  file?: string;
  /** Restrict to sessions carrying these label ids. */
  label?: string[];
  /** How `label` narrows when it has more than one id: "any" (union, default) or "all" (intersection). */
  labelMode?: LabelFilterMode;
  includeGenerated: boolean;
  sort: SessionSort;
  limit: number;
  offset: number;
}

export interface SessionDetailResponse {
  session: SessionRow;
}

/** GET /api/labels — every active label definition. */
export interface LabelsResponse {
  labels: LabelRecord[];
}
/** Response for a single label create/rename. */
export interface LabelResponse {
  label: LabelRecord;
}
/** GET /api/sessions/:id/labels — a session's labels plus its per-task labels. */
export interface SessionLabelsResponse {
  labels: SessionLabels;
}
/** POST /api/sessions/bulk/labels-lookup — active session-level labels for many sessions at once,
 *  keyed by session id (sessions with no labels are omitted). */
export interface BulkSessionLabelsResponse {
  labels: Record<string, AppliedLabel[]>;
}

/** Server-side filters parsed from a dashboard view's query string. Each narrows the store read
 *  (since/until/project/source); omitted fields fall back to the serve process's base options. Every
 *  per-view endpoint takes the same set. */
export interface SnapshotFilters {
  since?: string;
  until?: string;
  project?: string;
  source?: "all" | TranscriptSource;
}

/** A per-view reader: builds one view's response from the store, narrowed by `filters`. */
export type ViewReader<T> = (filters: SnapshotFilters) => Promise<T>;

/** The per-view readers serve wires into the dashboard endpoints (#217). Each opens the store, reads
 *  only the breakdown its endpoint needs, and shapes it — there is no monolithic Dashboard build. */
export interface ViewReaders {
  usageDaily: ViewReader<UsageDailyResponse>;
  usageByModel: ViewReader<UsageByModelResponse>;
  usageBySource: ViewReader<UsageBySourceResponse>;
  usageBySourceDaily: ViewReader<UsageBySourceDailyResponse>;
  usageByProject: ViewReader<UsageByProjectResponse>;
  usageSessionsBySource: ViewReader<SessionsBySourceResponse>;
  skills: ViewReader<SkillsResponse>;
  toolsByTool: ViewReader<ByToolResponse>;
  toolsByCategory: ViewReader<ByToolCategoryResponse>;
  toolsByMcpServer: ViewReader<ByMcpServerResponse>;
  toolsHeaviestResults: ViewReader<HeaviestResultsResponse>;
  plugins: ViewReader<PluginsResponse>;
  health: ViewReader<HealthResponse>;
  recommendations: ViewReader<RecommendationsResponse>;
}
export type SessionReindexer = (sessionId: string) => Promise<ReindexSessionResult>;
/** Flag/unflag a session as hidden (local-only UI state). */
export type SessionHiddenSetter = (sessionId: string, hidden: boolean) => Promise<void>;
/** Flag/unflag many sessions as hidden at once (bulk mode). */
export type SessionsHiddenSetter = (sessionIds: string[], hidden: boolean) => Promise<void>;
/** Roll up every task's metrics for a session on demand (one store pass), keyed by task id. */
export type SessionTaskMetricsReader = (sessionId: string) => Promise<Record<string, TaskMetrics>>;
/** A filtered/sorted/paginated page of session list rows, backed by the store's session aggregates. */
export type SessionListReader = (query: SessionListQuery) => Promise<SessionListResponse>;
/** Full detail for one session (built on demand), or null if it has no messages / doesn't exist. */
export type SessionDetailReader = (sessionId: string) => Promise<SessionRow | null>;
/** The interaction timeline for one session (prompt -> loop summary -> response), or null if the
 *  session has no interactions. */
export type SessionInteractionsReader = (sessionId: string) => Promise<SessionInteractionsResponse | null>;
/** Structural-index provenance for one session (transcript files + lineage), or null if unknown (#124). */
export type SessionProvenanceReader = (sessionId: string) => Promise<SessionProvenance | null>;
/** Gather the /debug payload (settings, env, paths, store/index status). */
export type DebugInfoReader = () => Promise<DebugInfo>;

/** The label operations serve wires into the label endpoints (session-and-task-labels). Reads use the
 *  shared read connection; writes open a short-lived writable store (like reindex), keeping the reader
 *  read-only. Writes may reject with a LabelError (bad name / duplicate / missing) the routes map to a
 *  4xx. Labels are local-only — nothing here touches the sync path. */
export interface LabelOps {
  list(): Promise<LabelRecord[]>;
  create(name: string): Promise<LabelRecord>;
  rename(id: string, name: string): Promise<LabelRecord>;
  remove(id: string): Promise<void>;
  readForSession(sessionId: string): Promise<SessionLabels>;
  /** Active session-level labels for many sessions at once (bulk mode's label picker). */
  readForSessions(sessionIds: string[]): Promise<Map<string, AppliedLabel[]>>;
  assign(labelId: string, target: LabelTarget, appliedBy?: LabelAppliedBy): Promise<void>;
  unassign(labelId: string, target: LabelTarget): Promise<void>;
  /** Apply/remove a session-level label across many sessions at once (bulk mode). */
  setForSessions(labelId: string, sessionIds: string[], applied: boolean): Promise<void>;
}

interface AppOptions {
  /** The per-view dashboard readers. Omitted in processes that don't read the store (the routes then
   *  answer 503); tests pass stubs to exercise routing without a store. */
  views?: ViewReaders;
  reindex?: SessionReindexer;
  /** Called after a successful reindex so the caller can drop its cached snapshot. */
  onStoreChanged?: () => void;
  sessionTaskMetrics?: SessionTaskMetricsReader;
  sessionList?: SessionListReader;
  sessionDetail?: SessionDetailReader;
  sessionInteractions?: SessionInteractionsReader;
  sessionProvenance?: SessionProvenanceReader;
  /** Flag/unflag a session as hidden. Omitted in processes without a store (503). */
  setSessionHidden?: SessionHiddenSetter;
  /** Flag/unflag many sessions as hidden at once (bulk mode). Omitted in processes without a store (503). */
  setSessionsHidden?: SessionsHiddenSetter;
  /** Session/task label read + write operations. Omitted in processes without a store (503). */
  labels?: LabelOps;
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
<p>The data API is live at <a href="/api/usage/daily">/api/usage/daily</a>.</p></body>`;
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

/** Parse the shared dashboard-view filter query params (since/until/project/source), or return an
 *  error message string for a 400. Dates are passed through as YYYY-MM-DD strings (the store compares
 *  them lexically); only `source` is validated against the known set so a typo doesn't silently widen
 *  the result. Every per-view endpoint uses this. */
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
  const label = c.req.query("label");
  const labelMode = c.req.query("labelMode");
  if (labelMode && labelMode !== "any" && labelMode !== "all") return `Unknown labelMode "${labelMode}".`;
  return {
    since: c.req.query("since") || undefined,
    until: c.req.query("until") || undefined,
    source: source ? (source as "all" | TranscriptSource) : undefined,
    project: c.req.query("project") || undefined,
    q: c.req.query("q") || undefined,
    file: c.req.query("file") || undefined,
    label: label ? label.split(",").filter(Boolean) : undefined,
    labelMode: labelMode as LabelFilterMode | undefined,
    includeGenerated,
    sort: sort as SessionSort,
    limit: Math.min(MAX_SESSION_LIMIT, Math.max(1, parseIntOr(c.req.query("limit"), DEFAULT_SESSION_LIMIT))),
    offset: Math.max(0, parseIntOr(c.req.query("offset"), 0)),
  };
}

/** Map a LabelError to its HTTP status (name conflict → 409, missing → 404, else 400); anything else
 *  rethrows and becomes a 500. */
function labelErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof LabelError) {
    const status = err.code === "name_conflict" ? 409 : err.code === "not_found" ? 404 : 400;
    return c.json({ error: err.message }, status);
  }
  throw err;
}

/** Read a required non-empty string field from a JSON body, or return a 400 Response. */
async function readJsonStringField(c: Context, field: string): Promise<string | Response> {
  let value: unknown;
  try {
    value = (await c.req.json())?.[field];
  } catch {
    return c.json({ error: `Expected a JSON body with a "${field}".` }, 400);
  }
  if (typeof value !== "string" || !value.trim()) {
    return c.json({ error: `Missing "${field}".` }, 400);
  }
  return value.trim();
}

/** Read a required non-empty array of non-empty strings from a JSON body, or return a 400 Response. */
async function readJsonStringArrayField(c: Context, field: string): Promise<string[] | Response> {
  let value: unknown;
  try {
    value = (await c.req.json())?.[field];
  } catch {
    return c.json({ error: `Expected a JSON body with a "${field}".` }, 400);
  }
  if (
    !Array.isArray(value) ||
    !value.length ||
    !value.every((v) => typeof v === "string" && v.trim())
  ) {
    return c.json({ error: `Missing or empty "${field}".` }, 400);
  }
  return value.map((v) => v.trim());
}

/** Read a required boolean field from a JSON body, or return a 400 Response. */
async function readJsonBooleanField(c: Context, field: string): Promise<boolean | Response> {
  let value: unknown;
  try {
    value = (await c.req.json())?.[field];
  } catch {
    return c.json({ error: `Expected a JSON body with a "${field}".` }, 400);
  }
  if (typeof value !== "boolean") {
    return c.json({ error: `Missing "${field}".` }, 400);
  }
  return value;
}

/** Parse a non-negative integer task position from a route param, or null if malformed. */
function parseTaskSeq(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Build the Hono app: the JSON API plus static serving of the SPA. Pure wiring — no listening,
 *  no transcript reading — so it can be exercised directly in tests. */
export function createApp(webRoot: string | null, opts: AppOptions = {}): Hono {
  const app = new Hono();

  // Cheap liveness check: no store access, just confirms the server is answering. The desktop app's
  // front-door proxy polls this to know when a restarting sidecar is back up.
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Per-view dashboard endpoints (#217): each reads exactly what its view needs from argus.db on
  // demand — no monolithic snapshot. All share the since/until/project/source filter contract (unknown
  // source → 400), and answer 503 when the reader isn't wired in this process.
  const views = opts.views;
  const viewRoute = <T,>(path: string, reader: ViewReader<T> | undefined): void => {
    app.get(path, async (c) => {
      if (!reader) return c.json({ error: "Dashboard data is unavailable in this process." }, 503);
      const filters = parseSnapshotFilters(c);
      if (typeof filters === "string") return c.json({ error: filters }, 400);
      return c.json(await reader(filters));
    });
  };
  viewRoute("/api/usage/daily", views?.usageDaily);
  viewRoute("/api/usage/by-model", views?.usageByModel);
  viewRoute("/api/usage/by-source", views?.usageBySource);
  viewRoute("/api/usage/by-source-daily", views?.usageBySourceDaily);
  viewRoute("/api/usage/by-project", views?.usageByProject);
  viewRoute("/api/usage/sessions-by-source", views?.usageSessionsBySource);
  viewRoute("/api/skills", views?.skills);
  viewRoute("/api/tools/by-tool", views?.toolsByTool);
  viewRoute("/api/tools/by-category", views?.toolsByCategory);
  viewRoute("/api/tools/by-mcp-server", views?.toolsByMcpServer);
  viewRoute("/api/tools/heaviest-results", views?.toolsHeaviestResults);
  viewRoute("/api/plugins", views?.plugins);
  viewRoute("/api/health", views?.health);
  viewRoute("/api/recommendations", views?.recommendations);

  // Paginated, filtered, sorted session list — backed by SQL session aggregates (no per-message JS
  // walk). The dashboard views are separate per-view endpoints; sessions were never in them.
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

  // The interaction timeline for one session (prompt -> loop summary -> response), built on demand and
  // fetched only when the detail view's Timeline tab is opened.
  app.get("/api/session/:id/interactions", async (c) => {
    if (!opts.sessionInteractions) return c.json({ error: "Session interactions are unavailable in this process." }, 503);
    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    const timeline = await opts.sessionInteractions(sessionId);
    if (!timeline) return c.json({ error: "Session not found." }, 404);
    return c.json(timeline satisfies SessionInteractionsResponse);
  });

  // Structural-index provenance for one session (transcript files + subagent/resumed lineage), built on
  // demand for the detail view's "Session Data" card. Local-only (index_* is never synced).
  app.get("/api/session/:id/provenance", async (c) => {
    if (!opts.sessionProvenance) return c.json({ error: "Session provenance is unavailable in this process." }, 503);
    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    const provenance = await opts.sessionProvenance(sessionId);
    if (!provenance) return c.json({ error: "Session not found." }, 404);
    return c.json(provenance satisfies SessionProvenance);
  });

  // Hide/unhide many sessions at once (bulk mode). Registered before the single-id route below so
  // the literal "bulk" segment isn't swallowed by that route's ":id" param.
  app.post("/api/sessions/bulk/hidden", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!opts.setSessionsHidden) return c.json({ error: "Hiding sessions is unavailable in this process." }, 503);

    const sessionIds = await readJsonStringArrayField(c, "sessionIds");
    if (!Array.isArray(sessionIds)) return sessionIds;
    const hidden = await readJsonBooleanField(c, "hidden");
    if (typeof hidden !== "boolean") return hidden;

    await opts.setSessionsHidden(sessionIds, hidden);
    opts.onStoreChanged?.();
    return c.json({ hidden });
  });

  // Hide/unhide a session (local-only UI state): excluded from the sessions list and search while
  // hidden, but its usage still counts in aggregate rollups. No feature-gate beyond store availability
  // — unlike reindex, this is a pure store write.
  app.post("/api/sessions/:id/hidden", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;

    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    if (!opts.setSessionHidden) return c.json({ error: "Hiding sessions is unavailable in this process." }, 503);

    const hidden = await readJsonBooleanField(c, "hidden");
    if (typeof hidden !== "boolean") return hidden;

    await opts.setSessionHidden(sessionId, hidden);
    opts.onStoreChanged?.();
    return c.json({ hidden });
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

  // Session/task labels (session-and-task-labels). Reads are open (like the other view endpoints);
  // every write gets the same CSRF guard as reindex. Labels are local-only and never leave the machine.
  const labels = opts.labels;
  const labelsUnavailable = (c: Context) => c.json({ error: "Labels are unavailable in this process." }, 503);

  app.get("/api/labels", async (c) => {
    if (!labels) return labelsUnavailable(c);
    return c.json({ labels: await labels.list() } satisfies LabelsResponse);
  });

  app.post("/api/labels", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const name = await readJsonStringField(c, "name");
    if (typeof name !== "string") return name;
    try {
      return c.json({ label: await labels.create(name) } satisfies LabelResponse);
    } catch (err) {
      return labelErrorResponse(c, err);
    }
  });

  app.patch("/api/labels/:id", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const id = c.req.param("id").trim();
    if (!id) return c.json({ error: "Missing label id." }, 400);
    const name = await readJsonStringField(c, "name");
    if (typeof name !== "string") return name;
    try {
      return c.json({ label: await labels.rename(id, name) } satisfies LabelResponse);
    } catch (err) {
      return labelErrorResponse(c, err);
    }
  });

  app.delete("/api/labels/:id", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const id = c.req.param("id").trim();
    if (!id) return c.json({ error: "Missing label id." }, 400);
    await labels.remove(id);
    return c.json({ ok: true });
  });

  // A session's labels + its per-task labels. Read path, so no CSRF guard.
  app.get("/api/sessions/:id/labels", async (c) => {
    if (!labels) return labelsUnavailable(c);
    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    return c.json({ labels: await labels.readForSession(sessionId) } satisfies SessionLabelsResponse);
  });

  // Active session-level labels for many sessions at once (bulk mode's tri-state label picker) — a
  // POST rather than GET since the id list can be large. Read path, so no CSRF guard. Registered
  // before the single-id route below so the literal "bulk" segment isn't swallowed by ":id".
  app.post("/api/sessions/bulk/labels-lookup", async (c) => {
    if (!labels) return labelsUnavailable(c);
    const sessionIds = await readJsonStringArrayField(c, "sessionIds");
    if (!Array.isArray(sessionIds)) return sessionIds;
    const bySession = await labels.readForSessions(sessionIds);
    return c.json({ labels: Object.fromEntries(bySession) } satisfies BulkSessionLabelsResponse);
  });

  // Apply / remove a session-level label across many sessions at once (bulk mode). Registered before
  // the single-id route below so the literal "bulk" segment isn't swallowed by that route's ":id" param.
  app.post("/api/sessions/bulk/labels", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const sessionIds = await readJsonStringArrayField(c, "sessionIds");
    if (!Array.isArray(sessionIds)) return sessionIds;
    const labelId = await readJsonStringField(c, "labelId");
    if (typeof labelId !== "string") return labelId;
    const applied = await readJsonBooleanField(c, "applied");
    if (typeof applied !== "boolean") return applied;
    try {
      await labels.setForSessions(labelId, sessionIds, applied);
      return c.json({ ok: true });
    } catch (err) {
      return labelErrorResponse(c, err);
    }
  });

  // Apply / remove a label on a session. The applier is a person using the web app, so applied_by is
  // "user" — combined with a system-origin label, that's the "user-applied system label" case.
  app.post("/api/sessions/:id/labels", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    const labelId = await readJsonStringField(c, "labelId");
    if (typeof labelId !== "string") return labelId;
    try {
      await labels.assign(labelId, { sessionId }, "user");
      return c.json({ ok: true });
    } catch (err) {
      return labelErrorResponse(c, err);
    }
  });

  app.delete("/api/sessions/:id/labels/:labelId", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const sessionId = c.req.param("id").trim();
    const labelId = c.req.param("labelId").trim();
    if (!sessionId || !labelId) return c.json({ error: "Missing session or label id." }, 400);
    await labels.unassign(labelId, { sessionId });
    return c.json({ ok: true });
  });

  // Apply / remove a label on a task, addressed by its position within the session.
  app.post("/api/sessions/:id/tasks/:taskSeq/labels", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const sessionId = c.req.param("id").trim();
    if (!sessionId) return c.json({ error: "Missing session id." }, 400);
    const taskSeq = parseTaskSeq(c.req.param("taskSeq"));
    if (taskSeq === null) return c.json({ error: "Invalid task position." }, 400);
    const labelId = await readJsonStringField(c, "labelId");
    if (typeof labelId !== "string") return labelId;
    try {
      await labels.assign(labelId, { sessionId, taskSeq }, "user");
      return c.json({ ok: true });
    } catch (err) {
      return labelErrorResponse(c, err);
    }
  });

  app.delete("/api/sessions/:id/tasks/:taskSeq/labels/:labelId", async (c) => {
    const blocked = rejectCrossSite(c);
    if (blocked) return blocked;
    if (!labels) return labelsUnavailable(c);
    const sessionId = c.req.param("id").trim();
    const labelId = c.req.param("labelId").trim();
    if (!sessionId || !labelId) return c.json({ error: "Missing session or label id." }, 400);
    const taskSeq = parseTaskSeq(c.req.param("taskSeq"));
    if (taskSeq === null) return c.json({ error: "Invalid task position." }, 400);
    await labels.unassign(labelId, { sessionId, taskSeq });
    return c.json({ ok: true });
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
    // Apply a log-level change to this serve process's logger right away, so terminal verbosity
    // changes without a restart (matters most for the tauri sidecar, which is long-lived). The
    // effective value already accounts for ARGUS_LOG_LEVEL winning over the file we just wrote, so
    // setting it here won't override an active env var.
    if (path === "log.level") {
      const level = normalizeLogLevel(result.setting.effectiveValue);
      if (level) logger.setLevel?.(level);
    }
    return c.json({ setting: result.setting });
  });

  // The welcome modal's "Don't show this again" checkbox (not a settings-surface field — see
  // `applyOnboardingCompleted`). Same CSRF/DNS-rebinding hardening as the other mutating endpoints.
  app.put("/api/onboarding", async (c) => {
    const blocked = rejectCrossSite(c) ?? rejectUnsafeHost(c);
    if (blocked) return blocked;
    let completed: unknown;
    try {
      completed = (await c.req.json())?.completed;
    } catch {
      return c.json({ error: 'Expected a JSON body with a "completed" boolean.' }, 400);
    }
    applyOnboardingCompleted(Boolean(completed), opts.configPath);
    return c.json({ completed: Boolean(completed) });
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
    return c.json(await testLlmConnection({ configPath: opts.configPath, secrets: secretStore(), log: opts.log }));
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
  // Run the two idempotent argus.json migrations off ONE disk read (each mutates this shared object and
  // writes the cumulative state, so order can't clobber). Both are guarded so a write failure can't
  // block startup. (1) Fold any legacy flat `llm.*` values under the provider they were written for (#154).
  // (2) Rename any legacy `taskExtraction.*` block to `sessionInterpretation.*` (#234) — resolution still
  // reads the legacy keys via each setting's legacy fallback, so this only makes the new key canonical.
  const startupConfig = loadConfig() as ArgusConfig & Record<string, unknown>;
  try {
    if (migrateLlmFlatToProviderConfigs(CONFIG_FILE, startupConfig))
      log("Organized LLM settings by provider in argus.json.");
  } catch (err) {
    log(`Couldn't reorganize LLM settings by provider: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    if (migrateTaskExtractionToSessionInterpretation(CONFIG_FILE, startupConfig))
      log("Renamed task-extraction settings to session interpretation in argus.json.");
  } catch (err) {
    log(`Couldn't update session-interpretation settings: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Resolve the `claude` CLI path once, here at startup — never on a request. The resolver may spawn a
  // login shell (up to a few seconds when `claude` isn't on PATH, the GUI-launch case #159 targets),
  // and spawnSync blocks the event loop, so doing it per `/api/settings` GET would stall the first
  // Settings load. Computed eagerly and passed in as the field's placeholder.
  const claudeBinary = resolveClaudeBinary();

  // No server-side cache: every view endpoint reads exactly what it needs from argus.db per request
  // (the client's TanStack Query staleTime absorbs rapid reloads). Map a request's filters onto a
  // store query, falling back to the serve process's base options for anything the request omits.
  const queryFor = (filters: SnapshotFilters): ResolvedQuery => ({
    sources: sourcesFor(filters.source ?? opts.build.source),
    since: filters.since ?? opts.build.since,
    until: filters.until ?? opts.build.until,
    projectSubstring: filters.project ?? opts.build.project,
  });
  // One read connection reused across every view + session request. Opening a store runs an integrity
  // scan (PRAGMA quick_check) + WAL setup, so re-opening per request — 4-6× per page load as the views
  // fan out — is wasteful. serve only reads; the store is WAL (one writer + many concurrent readers),
  // and every read here is autocommit (the `all()` helper is a bare SELECT, no BEGIN), so each query
  // starts a fresh snapshot that sees the `index` leg's latest committed writes and holds no lock
  // between requests. That's what makes a long-lived reader safe under `argus run`: it never goes
  // stale, and it can't pin the WAL and starve wal_autocheckpoint. Opened lazily (memoized on the
  // promise, so concurrent first-callers share one open) and closed on shutdown. The reindex path
  // keeps its own writable connection.
  let readStorePromise: Promise<Store> | undefined;
  const readStore = (): Promise<Store> => (readStorePromise ??= openStore());

  const withStore = async <T>(
    filters: SnapshotFilters,
    fn: (store: Store, query: ResolvedQuery) => Promise<T>,
  ): Promise<T> => fn(await readStore(), queryFor(filters));

  // Label writes are tiny but they mutate the store, so — like reindex — they run on a short-lived
  // writable connection rather than the long-lived read connection, keeping the reader read-only.
  // SQLite (WAL) serializes the write against the `index` leg via the busy timeout.
  const withWriteStore = async <T>(fn: (store: Store) => Promise<T>): Promise<T> => {
    const store = await openStore();
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  };

  // Assemble the per-plugin rows for a query — shared by the /api/plugins view and the unused-plugins
  // recommendation so the two can't drift for the same filters. Folding bySkill here also prices every
  // model seen (unattributed usage included), which populates the unpriced-model list the recommendation
  // rule reads.
  const byPluginFor = async (store: Store, query: ResolvedQuery): Promise<PluginRow[]> => {
    const plugins = loadPlugins();
    const [skillRows, mcpServers] = await Promise.all([
      store.readUsageBySkillModel(query),
      store.readMcpServers(query),
    ]);
    return buildPlugins(foldBySkill(skillRows, plugins), mcpServers, plugins).byPlugin;
  };

  const views: ViewReaders = {
    usageDaily: (filters) =>
      withStore(filters, async (store, query) => {
        const [rows, sessions] = await Promise.all([
          store.readUsageByDateModel(query),
          store.readSessionsBySource(query),
        ]);
        return buildUsageDaily(rows, sessions.reduce((n, r) => n + r.sessions, 0));
      }),
    usageByModel: (filters) =>
      withStore(filters, async (store, query) => buildUsageByModel(await store.readUsageByDateModel(query))),
    usageBySource: (filters) =>
      withStore(filters, async (store, query) => {
        const [rows, sessions, interactions, tasks] = await Promise.all([
          store.readUsageBySourceModel(query),
          store.readSessionsBySource(query),
          store.readInteractionsBySource(query),
          store.readTasksBySource(query),
        ]);
        return buildUsageBySource(rows, sessions, interactions, tasks);
      }),
    usageBySourceDaily: (filters) =>
      withStore(filters, async (store, query) =>
        buildUsageBySourceDaily(await store.readUsageByDateSourceModel(query)),
      ),
    usageByProject: (filters) =>
      withStore(filters, async (store, query) => {
        const [rows, sessions] = await Promise.all([
          store.readUsageByProjectModel(query),
          store.readSessionsByProject(query),
        ]);
        return buildUsageByProject(rows, sessions);
      }),
    usageSessionsBySource: (filters) =>
      withStore(filters, async (store, query) => buildSessionsBySource(await store.readSessionsByDateSource(query))),
    skills: (filters) =>
      withStore(filters, async (store, query) => {
        const [rows, byDate, dates] = await Promise.all([
          store.readUsageBySkillModel(query),
          store.readSkillTokensByDate(query),
          store.readActiveDates(query),
        ]);
        return buildSkills(rows, byDate, dates, loadPlugins());
      }),
    toolsByTool: (filters) =>
      withStore(filters, async (store, query) => {
        const [stats, results] = await Promise.all([store.readToolStats(query), store.readToolResultStats(query)]);
        return buildByTool(stats, results);
      }),
    toolsByCategory: (filters) =>
      withStore(filters, async (store, query) => {
        const [categories, stats, results] = await Promise.all([
          store.readToolCategoryStats(query),
          store.readToolStats(query),
          store.readToolResultStats(query),
        ]);
        return buildByToolCategory(categories, stats, results);
      }),
    toolsByMcpServer: (filters) =>
      withStore(filters, async (store, query) => {
        const [servers, serverTools, results] = await Promise.all([
          store.readMcpServers(query),
          store.readMcpServerTools(query),
          store.readToolResultStats(query),
        ]);
        return buildByMcpServer(servers, serverTools, results);
      }),
    toolsHeaviestResults: (filters) =>
      withStore(filters, async (store, query) => buildHeaviestResults(await store.readToolResultStats(query))),
    plugins: (filters) => withStore(filters, async (store, query) => ({ byPlugin: await byPluginFor(store, query) })),
    health: (filters) => withStore(filters, async (store, query) => buildHealth(await store.readHealthRollups(query))),
    recommendations: (filters) =>
      withStore(filters, async (store, query) => {
        const [byPlugin, health] = await Promise.all([byPluginFor(store, query), store.readHealthRollups(query)]);
        return {
          recommendations: computeRecommendations({
            byPlugin,
            highTokenGrowthSessions: health.highTokenGrowthSessions,
            frictionTotals: health.frictionTotals,
            // byPluginFor priced every model above, so the unpriced list is complete here.
            unpriced: unpricedModels(),
          }),
        };
      }),
  };

  const reindex: SessionReindexer = async (sessionId) => {
    // Honor the local text-retention opt-out (#120) on the web Refresh path: resolve it from config
    // (env > argus.json > default-on) the same way taskExtraction is resolved, and thread it through.
    // Resolved per request so a config change while serving takes effect.
    const retainText = resolveRetainText();
    // Refresh normally force-extracts tasks (deliberately unlike the CLI `index refresh`, which defers
    // to the config opt-in), keeping the configured provider/model — but only when we're retaining
    // text: with retention off we neither store the conversation nor run the model over it. A provider
    // explicitly set to "off" stays off.
    const reindexTaskExtraction: ResolvedSessionInterpretation = { ...opts.taskExtraction, enabled: retainText };
    const store = await openStore();
    try {
      return await reindexSession(sessionId, { store, taskExtraction: reindexTaskExtraction, retainText });
    } finally {
      await store.close();
    }
  };

  const sessionTaskMetrics: SessionTaskMetricsReader = async (sessionId) => {
    const store = await readStore();
    const [byTask, interactionCounts] = await Promise.all([
      store.readSessionTaskMessages(sessionId),
      store.readSessionTaskInteractionCounts(sessionId),
    ]);
    const out: Record<string, TaskMetrics> = {};
    for (const [taskId, messages] of byTask) out[taskId] = computeTaskMetrics(messages);
    // The interaction count comes from the spine (matches the timeline): it also covers interactions
    // with no usage rows, which the message-derived distinct-interactionSeq undercounts. A task with
    // interactions but no attributed messages still gets an entry (zeroed metrics + its count).
    for (const [taskId, n] of interactionCounts) {
      const m = out[taskId] ?? (out[taskId] = computeTaskMetrics([]));
      m.interactions = n;
    }
    return out;
  };

  const sessionList: SessionListReader = async (query) => {
    const store = await readStore();
    const sources = sourcesFor(query.source ?? opts.build.source);
    const since = query.since ?? opts.build.since;
    const until = query.until ?? opts.build.until;
    // A `q` or `file:` term (#155) runs a store-side search first: it resolves the candidate session
    // ids (+ per-session snippet/count) that then restrict the aggregate read, honoring the same
    // source/date narrowing. When neither is present, skip the search entirely — an unrestricted read.
    let sessionIds: string[] | undefined;
    let matches: Map<string, SessionSearchMatch> | undefined;
    if (query.q || query.file) {
      const search = await store.searchSessions({ sources, since, until, text: query.q, file: query.file });
      sessionIds = [...search.ids];
      matches = search.matches;
    }
    // A `label` filter (session-and-task-labels) intersects with any search-derived candidate set —
    // both narrow the same `sessionIds` restriction `readSessionAggregates` already honors.
    if (query.label?.length) {
      const labeled = await store.readSessionIdsForLabels(query.label, query.labelMode ?? "any");
      sessionIds = sessionIds ? sessionIds.filter((id) => labeled.has(id)) : [...labeled];
    }
    const aggregates = await store.readSessionAggregates({ sources, since, until, sessionIds });
    const list = buildSessionList(aggregates, {
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
      project: query.project,
      // The store already applied the metadata-OR-FTS `q` logic above; re-running the plain metadata
      // substring check here would wrongly drop a session that matched only via conversation/task FTS.
      q: matches ? undefined : query.q,
      includeGenerated: query.includeGenerated,
      matches,
    });
    // Attach session-level label chips — only for the paginated page, in one batched read.
    const labelsBySession = await store.readSessionLabelsForSessions(list.rows.map((r) => r.sessionId));
    if (labelsBySession.size) {
      list.rows = list.rows.map((r) => {
        const labels = labelsBySession.get(r.sessionId);
        return labels && labels.length ? { ...r, labels } : r;
      });
    }
    return list;
  };

  const sessionDetail: SessionDetailReader = async (sessionId) => {
    const store = await readStore();
    const messages = await store.readSessionMessages(sessionId);
    if (!messages.length) return null;
    const [meta, tasks, interpretation, isHidden, interactions] = await Promise.all([
      store.readSessionMeta(sessionId),
      store.readSessionTasks(sessionId),
      store.readSessionInterpretation(sessionId),
      store.readSessionHidden(sessionId),
      store.readSessionInteractionCount(sessionId),
    ]);
    return buildSessionDetail(sessionId, messages, meta, tasks, interpretation, isHidden, interactions);
  };

  const sessionInteractions: SessionInteractionsReader = async (sessionId) => {
    const store = await readStore();
    const [interactions, invocations, messages, tasks] = await Promise.all([
      store.readSessionInteractions(sessionId),
      store.readSessionInvocations(sessionId),
      store.readSessionMessages(sessionId),
      store.readSessionTasks(sessionId),
    ]);
    if (!interactions.length) return null;
    return buildSessionInteractions(interactions, invocations, messages, tasks);
  };

  const sessionProvenance: SessionProvenanceReader = async (sessionId) =>
    (await readStore()).readSessionProvenance(sessionId);

  const setSessionHidden: SessionHiddenSetter = (sessionId, hidden) =>
    withWriteStore((store) => store.setSessionsHidden([sessionId], hidden));

  const setSessionsHidden: SessionsHiddenSetter = (sessionIds, hidden) =>
    withWriteStore((store) => store.setSessionsHidden(sessionIds, hidden));

  const labels: LabelOps = {
    list: async () => (await readStore()).listLabels(),
    readForSession: async (sessionId) => (await readStore()).readSessionLabels(sessionId),
    readForSessions: async (sessionIds) => (await readStore()).readSessionLabelsForSessions(sessionIds),
    create: (name) => withWriteStore((store) => store.createLabel({ name })),
    rename: (id, name) => withWriteStore((store) => store.renameLabel(id, name)),
    remove: (id) => withWriteStore((store) => store.deleteLabel(id)),
    assign: (labelId, target, appliedBy) => withWriteStore((store) => store.assignLabel(labelId, target, appliedBy)),
    unassign: (labelId, target) => withWriteStore((store) => store.unassignLabel(labelId, target)),
    setForSessions: (labelId, sessionIds, applied) =>
      withWriteStore((store) => store.setLabelForSessions(labelId, sessionIds, applied)),
  };

  const app = createApp(webRoot, {
    views,
    reindex,
    sessionTaskMetrics,
    sessionList,
    sessionDetail,
    sessionInteractions,
    sessionProvenance,
    setSessionHidden,
    setSessionsHidden,
    labels,
    debugInfo: () => collectDebugInfo({ serveReadOnly: opts.build.readOnly ?? false }),
    secrets: defaultSecretStore(),
    claudeBinary,
    configPath: opts.configPath,
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

  // Bind to loopback only. The dashboard endpoints expose transcript-derived data and `serve` is
  // documented as a local-only tool; without an explicit hostname @hono/node-server listens on 0.0.0.0, which
  // would expose that data to anyone on the network.
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, (info) => {
    isListening = true;
    const url = `http://localhost:${info.port}`;
    log(`Listening on ${url} — press Ctrl-C to stop`);
    if (!webRoot) {
      logWarn(log, "The web app isn't built yet. Showing a placeholder. Run `bun run build:web` first.");
    }
    // Warm the store + unfiltered Activity read so the first page load is fast; failures surface on
    // the first real request.
    void views.usageDaily({}).catch(() => {});
    if (opts.open) {
      // Fresh install (or the welcome modal hasn't been dismissed yet): land on the welcome
      // overlay instead of the bare dashboard. `state.onboardingCompleted` is the same flag the
      // modal's "Don't show this again" checkbox writes via PUT /api/onboarding. Onboarding is
      // macOS-only (mirrors `onboarding_completed()` in desktop/src-tauri/src/lib.rs): other
      // platforms never read `state.onboardingCompleted` and always land on the bare dashboard.
      const onboardingCompleted =
        process.platform !== "darwin" ||
        (loadConfig(opts.configPath).state?.onboardingCompleted ?? false);
      spawnSync("open", [onboardingCompleted ? url : `${url}?firstRun=1`]);
    }
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
      server.close(() => {
        // Close the shared read connection (if it was ever opened) before signalling done.
        const closeStore = readStorePromise ? readStorePromise.then((s) => s.close()).catch(() => {}) : Promise.resolve();
        void closeStore.finally(() => resolveClosed());
      });
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
