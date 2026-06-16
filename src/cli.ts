#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { defineCommand, runMain, showUsage } from "citty";
import type { ArgsDef, CommandContext, ParsedArgs } from "citty";
import {
  isLegacyAccessTokenCache,
  isManagedOAuthTokenCache,
  loadAccessTokenCache,
  loginWithManagedOAuth,
  oauthCacheMatchesEndpoint,
  oauthTokenIsFresh,
  refreshManagedOAuthToken,
  saveAccessTokenCache,
} from "./auth.ts";
import { printBanner } from "./banner.ts";
import type { TranscriptSource } from "./parse.ts";
import { syncStatsSummary, scanStore } from "./parse-incremental.ts";
import { openSessionStore } from "./session-store.ts";
import { RENDERERS, type OutputFormat } from "./renderers.ts";
import { detectOrg, detectUser, pushSnapshot, SCHEMA_VERSION } from "./push.ts";
import type { PushCredentials } from "./push.ts";
import { ACCESS_TOKEN_FILE, STORE_FILE } from "./paths.ts";
import type { Dashboard } from "./aggregate.ts";
import { buildDashboard, buildDashboardDetailed, sourcesFor, type Log, type BuildDashboardOptions } from "./dashboard-builder.ts";
import { analyzeSession, cachedSessionAnalysis, formatSessionAnalysis } from "./session-analysis.ts";
import { startServer } from "./serve.ts";
import { openStore, rebuildStore } from "./store.ts";
import type { MessageRecord, ParseResult, SessionRow } from "./types.ts";
import pkg from "../package.json" with { type: "json" };

const DEFAULT_ENDPOINT = "https://argus.agentdeployment.co";
const DEFAULT_PORT = Number(process.env.ARGUS_PORT) || 4242;

type Source = "all" | TranscriptSource;

/** The store-selection slice shared by sync, reindex, and `forget --archived`. */
interface SyncOptions {
  source: Source;
  agentsView: "auto" | "off";
  agentsViewDatabasePath?: string;
}

// `buildDashboard` takes `BuildDashboardOptions` (from dashboard-builder); the command-specific
// option shapes below layer each subcommand's own flags on top of it.
interface ReportOptions extends BuildDashboardOptions {
  out: string;
  json: boolean;
  open: boolean;
}

interface ServeOptions extends BuildDashboardOptions {
  port: number;
  open: boolean;
}

interface PushOptions extends BuildDashboardOptions {
  endpoint: string;
  user?: string;
  org?: string;
}

interface ForgetOptions {
  source: Source;
  archived: boolean;
  ids: string[];
}

/** Narrow a raw `--source` value to the accepted set, exiting with a clear message otherwise. */
function toSource(value: string): Source {
  if (value === "all" || value === "claude" || value === "codex" || value === "gemini" || value === "cowork") return value;
  console.error(`Invalid --source: ${value} (expected claude, codex, gemini, cowork, or all)`);
  process.exit(2);
}

const log: Log = (s) => process.stderr.write(s + "\n");

/** Run a command body, reporting any failure as a single clean line (no stack) and exiting 1.
 *  citty's own runner prints unexpected errors with a full stack; routing expected operational
 *  failures (e.g. an unreadable store) through here keeps user-facing output plain. Argument
 *  errors are raised by citty before the body runs and keep its usage-aware handling. */
async function guard(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// citty parses non-strictly (Node's util.parseArgs with strict:false): unknown flags are silently
// accepted, and a value-less string flag swallows the following token as its value. The hand-rolled
// parser this replaced rejected both, so we re-check the raw argv against each command's declared
// flags to keep typos and missing values failing loudly (#59).

const BUILTIN_FLAGS = new Set(["help", "h", "version", "v"]);

const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const camel = (name: string): string => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** A flag name plus the camelCase/kebab-case spellings citty also accepts for it. */
const nameVariants = (name: string): string[] => [name, kebab(name), camel(name)];

function failArg(message: string): never {
  console.error(message);
  process.exit(2);
}

/** Reject unknown flags, value-less string flags (which would otherwise eat the next token), and
 *  stray positionals on commands that take none. */
function validateArgs(ctx: CommandContext<any>): void {
  const def = (ctx.cmd.args ?? {}) as ArgsDef;
  const allowed = new Set<string>();
  const stringFlags = new Set<string>();
  let acceptsPositional = false;
  for (const [name, rawSpec] of Object.entries(def)) {
    const spec = rawSpec as { type?: string; alias?: string | string[] };
    if (spec.type === "positional") {
      acceptsPositional = true;
      continue;
    }
    const aliases = Array.isArray(spec.alias) ? spec.alias : spec.alias ? [spec.alias] : [];
    for (const variant of [name, ...aliases].flatMap(nameVariants)) {
      allowed.add(variant);
      if (spec.type === "boolean") allowed.add(`no-${variant}`);
      if (spec.type === "string" || spec.type === "enum") stringFlags.add(variant);
    }
  }

  const raw = ctx.rawArgs;
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i]!;
    if (tok === "--") break; // end-of-options marker; the rest are operands
    if (tok === "-" || !tok.startsWith("-")) continue; // a value or positional, not a flag
    const body = tok.slice(tok.startsWith("--") ? 2 : 1);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    if (BUILTIN_FLAGS.has(name)) continue;
    if (!allowed.has(name)) failArg(`Unknown option: ${tok}`);
    // A string flag written as `--flag value` consumes the next token; skip it so a value isn't
    // re-read as a flag. An *omitted* value (the next token is itself a flag) is caught just below.
    if (eq === -1 && stringFlags.has(name) && i + 1 < raw.length && raw[i + 1] !== "--") i++;
  }

  // A string flag whose parsed value is itself a flag means its value was omitted and the following
  // flag got swallowed (e.g. `report --since --out x` parses as since="--out"). Treat as missing.
  const parsed = ctx.args as Record<string, unknown>;
  for (const [name, spec] of Object.entries(def)) {
    if (spec.type !== "string" && spec.type !== "enum") continue;
    const value = parsed[name];
    if (typeof value === "string" && value.length > 1 && value.startsWith("-")) {
      failArg(`Missing value for --${name} (got "${value}")`);
    }
  }

  if (!acceptsPositional && ctx.args._.length > 0) {
    failArg(`Unexpected argument: ${ctx.args._[0]}`);
  }
}

/** Wrap a subcommand handler: validate the raw argv first, then run the body through `guard`. */
function handler<T extends ArgsDef>(
  body: (args: ParsedArgs<T>) => Promise<void>,
): (ctx: CommandContext<T>) => Promise<void> {
  return (ctx) => {
    validateArgs(ctx);
    return guard(() => body(ctx.args));
  };
}

function summary(dash: Dashboard): string {
  return (
    `${dash.totals.sessions} sessions · ${dash.totals.messages} msgs · ` +
    `${(dash.totals.total / 1e6).toFixed(2)}M tokens · $${dash.totals.cost.toFixed(2)} est.`
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let amount = value / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && amount >= 1024; i++) {
    amount /= 1024;
    unit = units[i]!;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${unit}`;
}

async function runReport(opts: ReportOptions, log: Log, consoleOnly = false): Promise<void> {
  const dash = await buildDashboard(opts, log);
  const format: OutputFormat = consoleOnly ? "console" : opts.json ? "json" : "html";
  const rendered = RENDERERS[format](dash);
  if (rendered.toStdout) {
    process.stdout.write(rendered.content);
    return;
  }
  const outPath = resolve(opts.out);
  writeFileSync(outPath, rendered.content);
  log(`Wrote ${outPath}`);
  log(`Totals: ${summary(dash)}`);
  if (opts.open && format === "html") spawnSync("open", [outPath]);
}

async function runServe(opts: ServeOptions, log: Log): Promise<void> {
  await startServer(
    {
      port: opts.port,
      open: opts.open,
      build: {
        source: opts.source,
        agentsView: opts.agentsView,
        agentsViewDatabasePath: opts.agentsViewDatabasePath,
        since: opts.since,
        until: opts.until,
        project: opts.project,
        summarize: opts.summarize,
        summarizeModel: opts.summarizeModel,
      },
    },
    log,
  );
}

async function runLogin(opts: { endpoint: string }, log: Log): Promise<void> {
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  log(`Logging in to Cloudflare Access for ${endpoint}…`);

  try {
    const cache = await loginWithManagedOAuth(endpoint, { log });
    saveAccessTokenCache(ACCESS_TOKEN_FILE, cache);
    log("✓ Successfully authenticated and cached the OAuth tokens!");
  } catch (err) {
    log(`✗ Login failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runPush(opts: PushOptions, log: Log): Promise<void> {
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const user = detectUser(opts.user);
  const org = detectOrg(opts.org);

  // Authenticate:
  // 1. CI/Automation: CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET
  // 2. Human/Interactive: Cached Managed OAuth access + refresh tokens
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  const credentials: PushCredentials = {};

  if (clientId && clientSecret) {
    credentials.clientId = clientId;
    credentials.clientSecret = clientSecret;
  } else {
    let cached = loadAccessTokenCache(ACCESS_TOKEN_FILE);
    if (isManagedOAuthTokenCache(cached) && oauthCacheMatchesEndpoint(cached, endpoint)) {
      if (!oauthTokenIsFresh(cached)) {
        log("Refreshing Cloudflare Access login…");
        try {
          cached = await refreshManagedOAuthToken(cached);
          saveAccessTokenCache(ACCESS_TOKEN_FILE, cached);
        } catch (err) {
          log(`! Login refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          cached = undefined;
        }
      }
      if (isManagedOAuthTokenCache(cached)) credentials.bearerToken = cached.accessToken;
    } else if (isLegacyAccessTokenCache(cached)) {
      // Preserve existing cloudflared caches during migration.
      credentials.jwt = cached.token;
    }

    if (!credentials.bearerToken && !credentials.jwt) {
      log("! Unauthenticated. Please run 'argus login' first to authenticate via Cloudflare Access.");
      process.exit(1);
    }
  }

  const dash = await buildDashboard(opts, log);
  log(`Pushing snapshot for "${user}" (org: ${org ?? "from token"}) → ${endpoint}`);
  log(`  ${summary(dash)}`);

  const res = await pushSnapshot(endpoint, credentials, {
    schemaVersion: SCHEMA_VERSION,
    org,
    user,
    generatedAtMs: dash.generatedAtMs,
    // Cast: the schema's AgentSource union lags the local one by one source ("cowork" pending
    // argus-schema update). The server will reject cowork sessions at runtime until then.
    dashboard: dash as any,
  });

  if (res.ok) {
    log(`✓ Pushed (${res.status}). ${res.body.slice(0, 200)}`);
  } else if (res.isAccessChallenge) {
    log(`✗ Push failed (${res.status}): Cloudflare Access login required or token has expired.`);
    log(`  Please run 'argus login' to authenticate.`);
    process.exit(1);
  } else {
    log(`✗ Push failed (${res.status}): ${res.body.slice(0, 400)}`);
    process.exit(1);
  }
}

async function runStatus(log: Log): Promise<void> {
  log(`Store path: ${STORE_FILE}`);
  try {
    log(`Store size: ${formatBytes(statSync(STORE_FILE).size)}`);
  } catch {
    log("Store size: unavailable");
  }
  let scans;
  try {
    scans = await scanStore({ sources: ["claude", "codex", "gemini", "cowork"] });
  } catch (err) {
    log(`Couldn't read the local store: ${err instanceof Error ? err.message : String(err)}`);
    log("Run `argus reindex --force` to rebuild it from your transcripts.");
    process.exit(1);
  }

  // Count every session the store actually holds, grouped by where it came from, so the per-source
  // lines and the total reconcile with what `argus sync` reports (which counts the whole store).
  let counts: Array<{ owner: string; present: number; archived: number }> = [];
  try {
    const store = await openStore();
    try {
      counts = await store.resolvedSessionCounts();
    } finally {
      await store.close();
    }
  } catch {
    // best-effort; the scan above already reported store availability
  }
  const byOwner = new Map(counts.map((c) => [c.owner, c]));
  const nativeIds = new Set(scans.map((scan) => scan.source));

  const lines: string[] = [];
  let total = 0;
  let totalArchived = 0;
  let pending = false;

  // Native sources the user actually uses (transcripts on disk, a prior sync, or archived sessions).
  for (const scan of scans) {
    const c = byOwner.get(scan.source) ?? { owner: scan.source, present: 0, archived: 0 };
    if (!scan.inUse && c.present + c.archived === 0) continue;
    total += c.present + c.archived;
    totalArchived += c.archived;
    if (!scan.upToDate) pending = true;
    const when = scan.lastSyncAtMs ? new Date(scan.lastSyncAtMs).toISOString() : "never";
    const state = scan.upToDate ? "up to date" : "pending changes";
    const archived = c.archived ? ` (+${c.archived} archived)` : "";
    lines.push(`  ${scan.source}: ${c.present} sessions${archived} · last synced ${when} · ${state}`);
  }
  // Imported sources (e.g. AgentsView) — sessions read from another tool, not from transcripts on disk.
  for (const c of counts) {
    if (nativeIds.has(c.owner) || c.present + c.archived === 0) continue;
    total += c.present + c.archived;
    totalArchived += c.archived;
    const label = c.owner === "agentsview" ? "AgentsView" : c.owner;
    const archived = c.archived ? ` (+${c.archived} archived)` : "";
    lines.push(`  ${label}: ${c.present} sessions imported${archived}`);
  }

  if (!lines.length) {
    log("No sessions yet. Run `argus sync` once you've used Claude Code, Claude Cowork, Codex, or Gemini.");
    return;
  }
  for (const line of lines) log(line);
  if (lines.length > 1) log(`Total: ${total} sessions`);
  if (totalArchived) {
    log(`Kept after leaving disk: ${totalArchived} session${totalArchived === 1 ? "" : "s"} · remove with \`argus forget --archived\``);
  }
  if (pending) log("Run `argus sync` to pick up new and changed sessions.");
}

/** Bring the store up to date for the requested sources (producers reconcile + materialize). */
async function runSync(opts: SyncOptions, log: Log): Promise<void> {
  const store = openSessionStore({
    sources: sourcesFor(opts.source),
    agentsView: opts.agentsView,
    agentsViewDatabasePath: opts.agentsViewDatabasePath,
  });
  try {
    const parsed = await store.read({});
    if (store.stats) log(syncStatsSummary(store.stats, store.diagnostics));
    log(`Local store now has ${parsed.sessions.size} sessions and ${parsed.messages.length} messages.`);
  } finally {
    await store.close();
  }
}

async function runReindex(opts: SyncOptions & { force: boolean }, log: Log): Promise<void> {
  if (opts.force) {
    // Destructive: drop the entire store, including archived (off-disk) sessions that cannot be
    // re-derived from disk. Gated behind --force and announced before we delete anything. Counting
    // archived sessions is best-effort — a damaged store can't be read, but --force still rebuilds it.
    let archived: string[] = [];
    try {
      const store = await openStore();
      try {
        archived = await store.listArchived();
      } finally {
        await store.close();
      }
    } catch {
      // store unreadable; the rebuild below replaces it regardless
    }
    if (archived.length) {
      log(`! --force will permanently delete ${archived.length} archived session(s) no longer on disk.`);
    }
    const rebuilt = await rebuildStore();
    await rebuilt.close();
    log("Rebuilt the local store from scratch. Re-reading all transcripts from disk…");
  } else {
    // Non-destructive: re-derive the structural index from disk while preserving the trusted read
    // model (resolved_*), so aged-out archived sessions survive a reindex.
    const store = await openStore();
    try {
      await store.clearIndex();
    } finally {
      await store.close();
    }
    log("Re-reading all transcripts from disk. Archived sessions (no longer on disk) are kept…");
  }
  await runSync(opts, log);
}

async function runForget(opts: ForgetOptions, log: Log): Promise<void> {
  const store = await openStore();
  try {
    const targets = opts.archived
      ? await store.listArchived(opts.source === "all" ? undefined : opts.source)
      : opts.ids;
    if (!targets.length) {
      log(
        opts.archived
          ? "No archived sessions to forget."
          : "Usage: argus forget <session-id>… (or --archived to remove every session no longer on disk).",
      );
      return;
    }
    await store.retractSessions(targets);
    log(`Forgot ${targets.length} session(s) from the local store.`);
  } finally {
    await store.close();
  }
}

interface AnalyzeOptions extends BuildDashboardOptions {
  session?: string;
  listSessions: boolean;
  allColumns: boolean;
  unanalyzed: boolean;
  analysisModel?: string;
  refreshAnalysis: boolean;
  analysisLlm: boolean;
  json: boolean;
}

function compact(value: string, width: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (width <= 0) return "";
  if (normalized.length <= width) return normalized;
  if (width <= 3) return ".".repeat(width);
  return `${normalized.slice(0, width - 3)}...`;
}

function sessionDate(row: SessionRow): string {
  if (!row.start) return "(unknown)";
  return new Date(row.start).toISOString().slice(0, 16).replace("T", " ");
}

function displaySessionId(sessionId: string): string {
  const firstDash = sessionId.indexOf("-");
  if (firstDash < 0) return sessionId;
  const secondDash = sessionId.indexOf("-", firstDash + 1);
  if (secondDash < 0) return sessionId;
  return `${sessionId.slice(0, secondDash + 1)}...`;
}

interface SessionListColumn {
  label: string;
  minWidth: number;
  weight?: number;
  align?: "left" | "right";
}

const FALLBACK_TERMINAL_COLUMNS = 120;
const SESSION_LIST_TERMINAL_RATIO = 0.75;

function terminalColumns(): number {
  const columns = process.stdout.columns;
  return Number.isFinite(columns) && columns >= 40 ? Math.floor(columns) : FALLBACK_TERMINAL_COLUMNS;
}

function sessionListTableColumns(): number {
  return Math.max(40, Math.floor(terminalColumns() * SESSION_LIST_TERMINAL_RATIO));
}

function sessionListColumns(allColumns: boolean): SessionListColumn[] {
  const columns: SessionListColumn[] = [
    { label: "Title", minWidth: 12, weight: 3 },
    { label: "Messages", minWidth: 8, align: "right" },
    { label: "Session", minWidth: 10, weight: 2 },
    { label: "Started", minWidth: 16 },
  ];
  if (allColumns) {
    columns.push(
      { label: "Project", minWidth: 8, weight: 1 },
      { label: "Log", minWidth: 8, weight: 4 },
    );
  }
  return columns;
}

function sessionListWidths(columns: SessionListColumn[], terminalWidth: number): number[] {
  const separatorWidth = Math.max(0, columns.length - 1) * 2;
  const targetWidth = Math.max(0, terminalWidth - separatorWidth);
  const widths = columns.map((column) => Math.max(column.minWidth, column.label.length));
  let extra = targetWidth - widths.reduce((sum, width) => sum + width, 0);
  const flexible = columns
    .map((column, index) => ({ index, weight: column.weight ?? 0 }))
    .filter((column) => column.weight > 0);

  if (extra < 0) {
    let deficit = -extra;
    const shrinkable = [...flexible].sort((a, b) => b.weight - a.weight);
    while (deficit > 0) {
      const column = shrinkable.find((candidate) => widths[candidate.index]! > columns[candidate.index]!.label.length);
      if (!column) break;
      widths[column.index]!--;
      deficit--;
    }
    return widths;
  }

  if (extra === 0) return widths;
  if (!flexible.length) return widths;

  const totalWeight = flexible.reduce((sum, column) => sum + column.weight, 0);
  let used = 0;
  for (const column of flexible) {
    const added = Math.floor((extra * column.weight) / totalWeight);
    widths[column.index]! += added;
    used += added;
  }
  extra -= used;
  for (let i = 0; extra > 0; i++, extra--) {
    widths[flexible[i % flexible.length]!.index]!++;
  }
  return widths;
}

function renderSessionListCell(value: string, width: number, align: "left" | "right" = "left"): string {
  const text = compact(value, width);
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function formatSessionList(
  rows: SessionRow[],
  limit = 40,
  titles = new Map<string, string>(),
  logPaths = new Map<string, string>(),
  allColumns = false,
): string {
  if (!rows.length) return "No sessions matched the selected filters.\n";
  const shown = rows.slice(0, limit);
  const columns = sessionListColumns(allColumns);
  const widths = sessionListWidths(columns, sessionListTableColumns());
  const renderRow = (values: string[], header = false): string =>
    values
      .map((value, index) => renderSessionListCell(value, widths[index]!, header ? "left" : columns[index]?.align))
      .join("  ");
  const lines = [
    "Available sessions for analysis",
    "",
    renderRow(columns.map((column) => column.label), true),
  ];
  for (let i = 0; i < shown.length; i++) {
    const row = shown[i]!;
    const prefix = titles.has(row.sessionId) ? "✓ " : "· ";
    const title = prefix + (titles.get(row.sessionId) || row.firstPrompt);
    const values = [
      title,
      String(row.messages),
      displaySessionId(row.sessionId),
      sessionDate(row),
    ];
    if (allColumns) {
      values.push(row.project, logPaths.get(row.sessionId) ?? "");
    }
    lines.push(renderRow(values));
  }
  if (rows.length > shown.length) lines.push(``, `Showing ${shown.length} of ${rows.length} sessions. Narrow with --source, --since, --until, or --project.`);
  return `${lines.join("\n")}\n`;
}

function sessionSearchText(row: SessionRow): string {
  return [row.sessionId, row.project, row.firstPrompt, row.summary].join("\n").toLowerCase();
}

function resolveSession(rows: SessionRow[], selector: string): { row?: SessionRow; error?: string; matches?: SessionRow[] } {
  const value = selector.trim();
  const exact = rows.find((row) => row.sessionId === value);
  if (exact) return { row: exact };
  const needle = value.toLowerCase();
  const matches = rows.filter((row) => sessionSearchText(row).includes(needle));
  if (matches.length === 1) return { row: matches[0] };
  if (!matches.length) return { error: `No session matched "${selector}".` };
  return {
    error: `Session selector "${selector}" matched ${matches.length} sessions. Use a more specific id or substring.`,
    matches,
  };
}

function messagesForSession(parseResult: ParseResult, sessionId: string): MessageRecord[] {
  return parseResult.messages.filter((message) => message.sessionId === sessionId);
}

function cachedAnalysisTitles(rows: SessionRow[], parseResult: ParseResult): Map<string, string> {
  const titles = new Map<string, string>();
  for (const row of rows) {
    const analysis = cachedSessionAnalysis({
      row,
      messages: messagesForSession(parseResult, row.sessionId),
    });
    if (analysis?.title) titles.set(row.sessionId, analysis.title);
  }
  return titles;
}

function sessionLogPaths(rows: SessionRow[], parseResult: ParseResult): Map<string, string> {
  const paths = new Map<string, string>();
  for (const row of rows) {
    const filePath = parseResult.sessions.get(row.sessionId)?.filePath;
    if (filePath) paths.set(row.sessionId, filePath);
  }
  return paths;
}

function sessionsForJsonList(
  rows: SessionRow[],
  titles: Map<string, string>,
  logPaths: Map<string, string>,
): Array<SessionRow & { analysisTitle?: string; sessionLogPath: string }> {
  return rows.map((row) => {
    const title = titles.get(row.sessionId);
    return {
      ...row,
      analysisTitle: title || row.firstPrompt,
      sessionLogPath: logPaths.get(row.sessionId) ?? "",
    };
  });
}

async function promptForSession(
  rows: SessionRow[],
  titles: Map<string, string>,
  logPaths: Map<string, string>,
  allColumns: boolean,
  log: Log,
): Promise<SessionRow | undefined> {
  process.stdout.write(formatSessionList(rows, 20, titles, logPaths, allColumns));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("Select a session id or unique substring: ");
    if (!answer.trim()) return undefined;
    const selected = resolveSession(rows, answer);
    if (selected.error) {
      log(selected.error);
      if (selected.matches?.length) process.stdout.write(formatSessionList(selected.matches, 10, titles, logPaths, allColumns));
      return undefined;
    }
    return selected.row;
  } finally {
    rl.close();
  }
}

async function runAnalyze(opts: AnalyzeOptions, log: Log): Promise<void> {
  const { dash, parseResult } = await buildDashboardDetailed(opts, log);
  const titles = cachedAnalysisTitles(dash.sessions, parseResult);
  const logPaths = sessionLogPaths(dash.sessions, parseResult);
  const sessions = opts.unanalyzed
    ? dash.sessions.filter((row) => !titles.has(row.sessionId))
    : dash.sessions;
  if (opts.listSessions) {
    if (opts.json) {
      process.stdout.write(JSON.stringify(sessionsForJsonList(sessions, titles, logPaths), null, 2) + "\n");
    } else {
      process.stdout.write(formatSessionList(sessions, 40, titles, logPaths, opts.allColumns));
    }
    return;
  }

  if (!sessions.length) {
    log(opts.unanalyzed ? "All sessions have been analyzed." : "No sessions matched the selected filters.");
    process.exit(opts.unanalyzed ? 0 : 1);
  }

  let row: SessionRow | undefined;
  if (opts.session) {
    const selected = resolveSession(sessions, opts.session);
    if (selected.error) {
      log(selected.error);
      if (selected.matches?.length) process.stdout.write(formatSessionList(selected.matches, 10, titles, logPaths, opts.allColumns));
      process.exit(2);
    }
    row = selected.row;
  } else if (process.stdin.isTTY) {
    row = await promptForSession(sessions, titles, logPaths, opts.allColumns, log);
  } else {
    process.stdout.write(formatSessionList(sessions, 40, titles, logPaths, opts.allColumns));
    log("Pass --session <id|substring> to analyze a session in noninteractive mode.");
    process.exit(2);
  }

  if (!row) {
    log("No session selected.");
    process.exit(2);
  }

  const result = analyzeSession({
    row,
    meta: parseResult.sessions.get(row.sessionId),
    messages: messagesForSession(parseResult, row.sessionId),
    model: opts.analysisModel ?? opts.summarizeModel,
    refresh: opts.refreshAnalysis,
    useLlm: opts.analysisLlm,
    log,
  });
  if (result.fromCache) log("Using cached session analysis.");

  if (opts.json) {
    process.stdout.write(JSON.stringify({ fromCache: result.fromCache, analysis: result.analysis }, null, 2) + "\n");
  } else {
    process.stdout.write(formatSessionAnalysis(result.analysis, result.fromCache));
  }
}

// ---------------------------------------------------------------------------
// CLI definition (citty). Each subcommand declares its own flags; --help scopes
// to that subcommand automatically and flag types flow into the run handlers.
// ---------------------------------------------------------------------------

/** Source selection — shared by report, serve, push, sync, reindex, and `forget --archived`.
 *  Declared as a string (not enum) so citty's flag inference stays intact; the value set is
 *  validated by `toSource`. */
const sourceArg = {
  source: {
    type: "string",
    default: "all",
    description: "Transcript source: claude, codex, gemini, cowork, or all",
    valueHint: "claude|codex|gemini|cowork|all",
  },
} as const;

/** AgentsView discovery — shared by the source-reading commands. */
const agentsViewArgs = {
  agentsview: {
    type: "boolean",
    default: true,
    description: "Auto-detect and import AgentsView sessions",
    negativeDescription: "Disable AgentsView discovery/import",
  },
  "agentsview-db": {
    type: "string",
    description: "Read a specific AgentsView sessions.db",
    valueHint: "path",
  },
} as const;

/** Date/project filters — shared by report, serve, and push. */
const filterArgs = {
  since: { type: "string", description: "Only include messages on/after this date", valueHint: "YYYY-MM-DD" },
  until: { type: "string", description: "Only include messages on/before this date", valueHint: "YYYY-MM-DD" },
  project: { type: "string", description: "Only include sessions whose directory contains this text", valueHint: "substr" },
} as const;

/** Summary generation — shared by report, serve, and push. */
const summarizeArgs = {
  summarize: { type: "boolean", default: false, description: "Generate per-session summaries via headless 'claude -p' (cached)" },
  "summarize-model": { type: "string", description: "Model for summaries (e.g. claude-haiku-4-5-20251001)", valueHint: "id" },
} as const;

/** Inputs shared by report, serve, and push (everything `buildDashboard` reads). */
const buildArgs = {
  ...sourceArg,
  ...agentsViewArgs,
  ...filterArgs,
  ...summarizeArgs,
} as const;

const reportArgs = {
  ...buildArgs,
  out: { type: "string", alias: "o", default: "argus-report.html", description: "Output path", valueHint: "file" },
  json: { type: "boolean", default: false, description: "Write raw aggregate JSON to --out instead of HTML" },
  console: { type: "boolean", default: false, description: "Print a compact overview to the terminal instead of writing a file" },
  open: { type: "boolean", default: false, description: "Open the report in your browser when done (macOS)" },
} as const;

type SyncArgs = { source: string; agentsview: boolean; "agentsview-db"?: string };
type BuildArgs = SyncArgs & { since?: string; until?: string; project?: string; summarize: boolean; "summarize-model"?: string };

function syncOptions(args: SyncArgs): SyncOptions {
  return {
    source: toSource(args.source),
    agentsView: args.agentsview ? "auto" : "off",
    agentsViewDatabasePath: args["agentsview-db"],
  };
}

function buildOptions(args: BuildArgs): BuildDashboardOptions {
  return {
    ...syncOptions(args),
    since: args.since,
    until: args.until,
    project: args.project,
    summarize: args.summarize,
    summarizeModel: args["summarize-model"],
  };
}

const report = defineCommand({
  meta: { name: "report", description: "build the local HTML (or --json) dashboard" },
  args: reportArgs,
  run: handler((args) => runReport({ ...buildOptions(args), out: args.out, json: args.json, open: args.open }, log, args.console)),
});

const serve = defineCommand({
  meta: { name: "serve", description: "serve the interactive dashboard at a local web address" },
  args: {
    ...buildArgs,
    port: { type: "string", alias: "p", default: String(DEFAULT_PORT), description: "Local port to listen on (env ARGUS_PORT)", valueHint: "N" },
    open: { type: "boolean", default: false, description: "Open the dashboard in your browser once it's ready (macOS)" },
  },
  run: handler((args) => runServe({ ...buildOptions(args), port: Number(args.port) || DEFAULT_PORT, open: args.open }, log)),
});

const sync = defineCommand({
  meta: { name: "sync", description: "read new and changed sessions into the local store" },
  args: { ...sourceArg, ...agentsViewArgs },
  run: handler((args) => runSync(syncOptions(args), log)),
});

const reindex = defineCommand({
  meta: { name: "reindex", description: "re-read all transcripts from disk (keeps archived); --force to wipe" },
  args: {
    ...sourceArg,
    ...agentsViewArgs,
    force: { type: "boolean", default: false, description: "Drop the whole store, including archived (off-disk) sessions" },
  },
  run: handler((args) => runReindex({ ...syncOptions(args), force: args.force }, log)),
});

const status = defineCommand({
  meta: { name: "status", description: "show the local store path + per-source counts" },
  run: handler(() => runStatus(log)),
});

const forget = defineCommand({
  meta: { name: "forget", description: "permanently remove sessions from the local store" },
  args: {
    id: { type: "positional", required: false, description: "session id(s) to forget" },
    ...sourceArg,
    archived: { type: "boolean", default: false, description: "Target all archived (off-disk) sessions, optionally scoped by --source" },
  },
  run: handler((args) => runForget({ source: toSource(args.source), archived: args.archived, ids: args._ }, log)),
});

const login = defineCommand({
  meta: { name: "login", description: "login via Cloudflare Access SSO in your browser" },
  args: {
    endpoint: { type: "string", default: process.env.ARGUS_ENDPOINT || DEFAULT_ENDPOINT, description: "Service URL for login (env ARGUS_ENDPOINT)", valueHint: "url" },
  },
  run: handler((args) => runLogin({ endpoint: args.endpoint }, log)),
});

const push = defineCommand({
  meta: { name: "push", description: "push your usage snapshot to a team Worker" },
  args: {
    ...buildArgs,
    endpoint: { type: "string", default: process.env.ARGUS_ENDPOINT || DEFAULT_ENDPOINT, description: "Service URL for push (env ARGUS_ENDPOINT)", valueHint: "url" },
    user: { type: "string", description: "Override the user id (default: git email, else $USER@host)", valueHint: "id" },
    org: { type: "string", default: process.env.ARGUS_ORG, description: "Override the org (env ARGUS_ORG)", valueHint: "id" },
  },
  run: handler((args) => runPush({ ...buildOptions(args), endpoint: args.endpoint, user: args.user, org: args.org }, log)),
});

const analyze = defineCommand({
  meta: { name: "analyze", description: "list, select, and deep-analyze one session" },
  args: {
    session: { type: "positional", required: false, description: "session id or unique substring to analyze" },
    ...buildArgs,
    list: { type: "boolean", alias: "l", default: false, description: "List available sessions" },
    "all-columns": { type: "boolean", default: false, description: "Show project and log path in session lists" },
    unanalyzed: { type: "boolean", default: false, description: "Only show or select sessions without a cached analysis" },
    "analysis-model": { type: "string", description: "Model for LLM session analysis (e.g. claude-haiku-4-5-20251001)", valueHint: "id" },
    "refresh-analysis": { type: "boolean", default: false, description: "Ignore cached analysis and regenerate it" },
    llm: { type: "boolean", default: true, description: "Use LLM analysis via headless 'claude -p' (cached)", negativeDescription: "Use local heuristic analysis only" },
    json: { type: "boolean", default: false, description: "Write the selected analysis as JSON" },
  },
  run: handler((args) => runAnalyze({
    ...buildOptions(args),
    session: args._[0],
    listSessions: args.list,
    allColumns: args["all-columns"],
    unanalyzed: args.unanalyzed,
    analysisModel: args["analysis-model"],
    refreshAnalysis: args["refresh-analysis"],
    analysisLlm: args.llm,
    json: args.json,
  }, log)),
});

const main = defineCommand({
  meta: {
    name: "argus",
    version: pkg.version,
    description: "audit your Claude Code, Claude Cowork, Codex, and Gemini CLI usage",
  },
  // No root flags and no default command: every flag belongs to a specific subcommand, so running
  // `argus` with no subcommand falls through to the usage/help. Sessions stay in the local store
  // even after their transcripts age off disk; only `argus forget` removes them.
  subCommands: { report, serve, sync, reindex, status, forget, login, push, analyze },
});

async function run() {
  printBanner();
  const argv = process.argv.slice(2);
  // A bare `argus` (no subcommand) shows the usage/help with a success exit code; citty's own
  // "no command specified" path would treat the same input as an error. `argus <command>` and
  // `argus --help` flow through citty normally.
  if (argv.length === 0) {
    await showUsage(main);
    return;
  }
  await runMain(main);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
