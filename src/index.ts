#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { aggregate } from "./aggregate.ts";
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
import { vendoredBrandFontsCss } from "./brand.ts";
import { vendoredChartJs } from "./chartjs.ts";
import { consoleOverview, isBareInvocation } from "./console-report.ts";
import { loadPlugins } from "./inventory.ts";
import { parseAll, type TranscriptSource } from "./parse.ts";
import {
  cacheStatsSummary,
  parseAllIncrementalDetailed,
} from "./parse-incremental.ts";
import { renderHtml } from "./report.ts";
import { claudeAvailable, heuristicSummary, llmSummaries } from "./summarize.ts";
import { analyzeSession, cachedSessionAnalysis, formatSessionAnalysis } from "./session-analysis.ts";
import { detectOrg, detectUser, pushSnapshot, SCHEMA_VERSION } from "./push.ts";
import type { PushCredentials } from "./push.ts";
import { ACCESS_TOKEN_FILE, FRAGMENT_CACHE_FILE } from "./paths.ts";
import type { Dashboard } from "./aggregate.ts";
import type { MessageRecord, ParseResult, SessionMeta, SessionRow } from "./types.ts";
import type { ParserDiagnostic } from "./cache-contract.ts";
import { openFragmentCache, rebuildFragmentCache } from "./cache-store.ts";

interface Flags {
  command: "report" | "push" | "login" | "cache-status" | "cache-rebuild" | "analyze";
  source: "all" | TranscriptSource;
  since?: string;
  until?: string;
  project?: string;
  out: string;
  summarize: boolean;
  summarizeModel?: string;
  open: boolean;
  json: boolean;
  cache: boolean;
  agentsView: "auto" | "off";
  agentsViewDatabasePath?: string;
  listSessions: boolean;
  allColumns: boolean;
  session?: string;
  analysisModel?: string;
  refreshAnalysis: boolean;
  analysisLlm: boolean;
  help: boolean;
  // push & login
  endpoint?: string;
  user?: string;
  org?: string;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    command: "report",
    source: "all",
    out: "argus-report.html",
    summarize: false,
    open: false,
    json: false,
    cache: true,
    agentsView: "auto",
    listSessions: false,
    allColumns: false,
    refreshAnalysis: false,
    analysisLlm: true,
    help: false,
    endpoint: process.env.ARGUS_ENDPOINT || "https://argus.agentdeployment.co",
    org: process.env.ARGUS_ORG,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case "report": f.command = "report"; break;
      case "push": f.command = "push"; break;
      case "login": f.command = "login"; break;
      case "cache-status": f.command = "cache-status"; break;
      case "cache-rebuild": f.command = "cache-rebuild"; break;
      case "analyze": f.command = "analyze"; break;
      case "--source": f.source = parseSource(next()); break;
      case "--since": f.since = next(); break;
      case "--until": f.until = next(); break;
      case "--project": f.project = next(); break;
      case "--out": case "-o": f.out = next() || f.out; break;
      case "--summarize": f.summarize = true; break;
      case "--summarize-model": f.summarizeModel = next(); break;
      case "--open": f.open = true; break;
      case "--json": f.json = true; break;
      case "--no-cache": f.cache = false; break;
      case "--agentsview": f.agentsView = "auto"; break;
      case "--no-agentsview": f.agentsView = "off"; break;
      case "--agentsview-db": f.agentsViewDatabasePath = next(); break;
      case "--list": f.listSessions = true; break;
      case "--all-columns": f.allColumns = true; break;
      case "--session": f.session = next(); break;
      case "--analysis-model": f.analysisModel = next(); break;
      case "--refresh-analysis": f.refreshAnalysis = true; break;
      case "--no-llm": f.analysisLlm = false; break;
      case "--endpoint": f.endpoint = next(); break;
      case "--user": f.user = next(); break;
      case "--org": f.org = next(); break;
      case "--help": case "-h": f.help = true; break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        if (f.command === "analyze" && !f.session) f.session = a;
    }
  }
  return f;
}

function parseSource(value: string | undefined): "all" | TranscriptSource {
  if (value === "all" || value === "claude" || value === "codex" || value === "gemini") return value;
  console.error(`Invalid --source: ${value ?? ""} (expected claude, codex, gemini, or all)`);
  process.exit(2);
}

function sourcesFor(source: "all" | TranscriptSource): TranscriptSource[] {
  return source === "all" ? ["claude", "codex", "gemini"] : [source];
}

const HELP = `argus — audit your Claude Code, Codex, and Gemini CLI usage

Usage:
  argus                       show a terminal overview
  argus report [options]      build the local HTML dashboard
  argus analyze [options]     list, select, and analyze one session
  argus login [options]       login via Cloudflare Access SSO in your browser
  argus push [options]        push your usage snapshot to a team Worker
  argus cache-status          show local fragment cache status
  argus cache-rebuild         delete and recreate the local fragment cache

Report options:
  --source <claude|codex|gemini|all>
                            transcript source to parse (default: all)
  --since <YYYY-MM-DD>     only include messages on/after this date
  --until <YYYY-MM-DD>     only include messages on/before this date
  --project <substr>       only include sessions whose project path matches substr
  -o, --out <file>         output HTML path (default: argus-report.html)
  --summarize              generate per-session LLM summaries via headless 'claude -p' (cached)
  --summarize-model <id>   model for summaries (e.g. claude-haiku-4-5-20251001)
  --open                   open the report in the default browser when done (macOS)
  --json                   write raw aggregate JSON to --out instead of HTML
  --no-cache               parse transcripts directly without the fragment cache
  --agentsview             auto-detect AgentsView imports (default)
  --no-agentsview          disable AgentsView discovery/import
  --agentsview-db <path>   read a specific AgentsView sessions.db

Analyze options (also honors --source/--since/--until/--project):
  --list                  list available sessions for analysis
  --all-columns           show project and session log path in session lists
  --session <id|substr>   analyze a selected session by id or unique substring
  --analysis-model <id>   model for headless 'claude -p' analysis
  --refresh-analysis      ignore cached session analysis and regenerate it
  --no-llm                use local heuristic analysis only
  --json                  write the selected analysis as JSON

Login options:
  --endpoint <url>         SSO service URL     (default: https://argus.agentdeployment.co)

Push options (also honors --since/--until/--project/--summarize):
  --endpoint <url>         Worker base URL     (or env ARGUS_ENDPOINT, default: https://argus.agentdeployment.co)
  --user <id>              override the user id (default: git email, else \$USER@host)
  --org <id>               override authenticated org (or env ARGUS_ORG)

  -h, --help               show this help

Reads transcripts from ~/.claude/projects (override dir via CLAUDE_CONFIG_DIR),
~/.codex/sessions (override dir via CODEX_HOME or CODEX_CONFIG_DIR), and
~/.gemini/tmp (override home via GEMINI_CLI_HOME).
`;

function withinRange(date: string, since?: string, until?: string): boolean {
  if (since && date < since) return false;
  if (until && date > until) return false;
  return true;
}

type Log = (s: string) => void;

interface DashboardBuildResult {
  dash: Dashboard;
  parseResult: ParseResult;
}

function diagnosticKey(entry: ParserDiagnostic): string {
  return `${entry.severity}\0${entry.code}\0${entry.message}`;
}

function uniqueDiagnostics(entries: ParserDiagnostic[]): ParserDiagnostic[] {
  const seen = new Set<string>();
  const out: ParserDiagnostic[] = [];
  for (const entry of entries) {
    const key = diagnosticKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function logCacheDiagnostics(
  diagnostics: ParserDiagnostic[],
  flags: Flags,
  log: Log,
): void {
  const surfacedInfo = new Set([
    "agentsview_import_used",
    "agentsview_native_precedence",
    "cache_file_changed",
    "cache_parser_version_changed",
    "cache_contract_version_changed",
    "cache_fragment_unavailable",
  ]);
  if (flags.agentsView === "off") surfacedInfo.add("agentsview_disabled");
  if (flags.agentsViewDatabasePath) surfacedInfo.add("agentsview_unavailable");

  const surfaced = uniqueDiagnostics(diagnostics).filter(
    (entry) => entry.severity !== "info" || surfacedInfo.has(entry.code),
  );
  const important = surfaced.filter((entry) => entry.severity !== "info").slice(0, 5);
  const info = surfaced.filter((entry) => entry.severity === "info").slice(0, 5);
  for (const entry of important) log(`  ! ${entry.message}`);
  for (const entry of info) log(`  i ${entry.message}`);
  const omitted = surfaced.length - important.length - info.length;
  if (omitted > 0) log(`  i ${omitted} additional cache diagnostics omitted.`);
}

/** Parse transcripts, apply filters, summarize, and build the aggregate dashboard. */
async function buildDashboardDetailed(flags: Flags, log: Log): Promise<DashboardBuildResult> {
  log("Parsing transcripts…");
  const parsed = flags.cache
    ? (await parseAllIncrementalDetailed({
        sources: sourcesFor(flags.source),
        agentsView: flags.agentsView,
        agentsViewDatabasePath: flags.agentsViewDatabasePath,
      }))
    : { parsed: parseAll({ sources: sourcesFor(flags.source) }), stats: undefined };
  if (flags.cache && parsed.stats && "diagnostics" in parsed) {
    log(`  Cache: ${cacheStatsSummary(parsed.stats, parsed.diagnostics)}`);
  } else if (flags.cache && parsed.stats) {
    log(`  Cache: ${cacheStatsSummary(parsed.stats)}`);
  }
  if (flags.cache && "diagnostics" in parsed) {
    logCacheDiagnostics(parsed.diagnostics, flags, log);
  }
  if (!flags.cache) log("  Cache: disabled.");
  const parseResult = parsed.parsed;

  // Apply filters.
  if (flags.since || flags.until || flags.project) {
    parseResult.messages = parseResult.messages.filter(
      (m) =>
        withinRange(m.date, flags.since, flags.until) &&
        (!flags.project || m.cwd.includes(flags.project)),
    );
    const keep = new Set(parseResult.messages.map((m) => m.sessionId));
    for (const sid of [...parseResult.sessions.keys()]) {
      if (!keep.has(sid)) parseResult.sessions.delete(sid);
    }
  }

  log(`  ${parseResult.messages.length} assistant messages across ${parseResult.sessions.size} sessions.`);

  const plugins = loadPlugins();

  // Build per-session last-timestamp + heuristic summaries first.
  const lastTs = new Map<string, number>();
  const factsBySession = new Map<string, { firstPrompt: string; topSkills: string[]; toolCounts: Record<string, number>; filesTouched: string[] }>();
  for (const m of parseResult.messages) {
    lastTs.set(m.sessionId, Math.max(lastTs.get(m.sessionId) || 0, m.ts));
    const f = factsBySession.get(m.sessionId) || {
      firstPrompt: parseResult.sessions.get(m.sessionId)?.firstPrompt || "",
      topSkills: [],
      toolCounts: {},
      filesTouched: [],
    };
    if (m.attributionSkill && !f.topSkills.includes(m.attributionSkill)) f.topSkills.push(m.attributionSkill);
    for (const tu of m.toolUses) {
      f.toolCounts[tu.name] = (f.toolCounts[tu.name] || 0) + 1;
      if (tu.filePath && !f.filesTouched.includes(tu.filePath)) f.filesTouched.push(tu.filePath);
    }
    factsBySession.set(m.sessionId, f);
  }

  const summaries = new Map<string, string>();

  if (flags.summarize) {
    if (!claudeAvailable()) {
      log("  ! 'claude' CLI not found on PATH — falling back to heuristic summaries.");
    } else {
      log(`Summarizing ${parseResult.sessions.size} sessions via claude -p (cached; incremental)…`);
      const targets: { meta: SessionMeta; lastTs: number }[] = [];
      for (const meta of parseResult.sessions.values()) {
        targets.push({ meta, lastTs: lastTs.get(meta.sessionId) || 0 });
      }
      const llm = llmSummaries(targets, flags.summarizeModel, log);
      for (const [sid, s] of llm) summaries.set(sid, s);
    }
  }

  // Fill any missing summaries with the heuristic.
  for (const [sid, f] of factsBySession) {
    if (!summaries.has(sid)) summaries.set(sid, heuristicSummary(f));
  }

  const dash = aggregate(parseResult, plugins, summaries);
  dash.generatedAtMs = Date.now();
  return { dash, parseResult };
}

async function buildDashboard(flags: Flags, log: Log): Promise<Dashboard> {
  return (await buildDashboardDetailed(flags, log)).dash;
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

async function runReport(flags: Flags, log: Log, consoleOnly = false): Promise<void> {
  const dash = await buildDashboard(flags, log);
  if (consoleOnly) {
    process.stdout.write(consoleOverview(dash));
    return;
  }
  const outPath = resolve(flags.out);
  if (flags.json) {
    writeFileSync(outPath, JSON.stringify(dash, null, 2));
  } else {
    writeFileSync(outPath, renderHtml(dash, { chartJs: vendoredChartJs(), fontCss: vendoredBrandFontsCss() }));
  }
  log(`Wrote ${outPath}`);
  log(`Totals: ${summary(dash)}`);
  if (flags.open && !flags.json) spawnSync("open", [outPath]);
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
    const title = titles.get(row.sessionId) || row.firstPrompt;
    const values = [
      title,
      String(row.messages),
      displaySessionId(row.sessionId),
      sessionDate(row),
    ];
    if (allColumns) {
      values.push(row.project, logPaths.get(row.sessionId) ?? "");
    }
    lines.push(
      renderRow(values),
    );
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

async function runAnalyze(flags: Flags, log: Log): Promise<void> {
  const { dash, parseResult } = await buildDashboardDetailed(flags, log);
  const titles = cachedAnalysisTitles(dash.sessions, parseResult);
  const logPaths = sessionLogPaths(dash.sessions, parseResult);
  if (flags.listSessions) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(sessionsForJsonList(dash.sessions, titles, logPaths), null, 2) + "\n");
    } else {
      process.stdout.write(formatSessionList(dash.sessions, 40, titles, logPaths, flags.allColumns));
    }
    return;
  }

  if (!dash.sessions.length) {
    log("No sessions matched the selected filters.");
    process.exit(1);
  }

  let row: SessionRow | undefined;
  if (flags.session) {
    const selected = resolveSession(dash.sessions, flags.session);
    if (selected.error) {
      log(selected.error);
      if (selected.matches?.length) process.stdout.write(formatSessionList(selected.matches, 10, titles, logPaths, flags.allColumns));
      process.exit(2);
    }
    row = selected.row;
  } else if (process.stdin.isTTY) {
    row = await promptForSession(dash.sessions, titles, logPaths, flags.allColumns, log);
  } else {
    process.stdout.write(formatSessionList(dash.sessions, 40, titles, logPaths, flags.allColumns));
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
    model: flags.analysisModel ?? flags.summarizeModel,
    refresh: flags.refreshAnalysis,
    useLlm: flags.analysisLlm,
    log,
  });
  if (result.fromCache) log("Using cached session analysis.");

  if (flags.json) {
    process.stdout.write(JSON.stringify({ fromCache: result.fromCache, analysis: result.analysis }, null, 2) + "\n");
  } else {
    process.stdout.write(formatSessionAnalysis(result.analysis, result.fromCache));
  }
}

async function runLogin(flags: Flags, log: Log): Promise<void> {
  const endpoint = flags.endpoint || "https://argus.agentdeployment.co";
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

async function runPush(flags: Flags, log: Log): Promise<void> {
  const endpoint = flags.endpoint || "https://argus.agentdeployment.co";
  const user = detectUser(flags.user);
  const org = detectOrg(flags.org);

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

  const dash = await buildDashboard(flags, log);
  log(`Pushing snapshot for "${user}" (org: ${org ?? "from token"}) → ${endpoint}`);
  log(`  ${summary(dash)}`);

  const res = await pushSnapshot(endpoint, credentials, {
    schemaVersion: SCHEMA_VERSION,
    org,
    user,
    generatedAtMs: dash.generatedAtMs,
    dashboard: dash,
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

async function runCacheStatus(log: Log): Promise<void> {
  log(`Cache path: ${FRAGMENT_CACHE_FILE}`);
  let cache;
  try {
    cache = await openFragmentCache();
  } catch (err) {
    log(`Cache unavailable: ${err instanceof Error ? err.message : String(err)}`);
    log("Run `argus cache-rebuild` to recreate the local fragment cache.");
    process.exit(1);
  }
  try {
    const rows = await cache.list();
    const successful = rows.filter((row) => row.status === "success");
    const bySource = new Map<string, number>();
    const byKind = new Map<string, number>();
    const byStatus = new Map<string, number>();
    for (const row of successful) {
      bySource.set(row.source ?? "external", (bySource.get(row.source ?? "external") ?? 0) + 1);
      byKind.set(row.kind, (byKind.get(row.kind) ?? 0) + 1);
    }
    for (const row of rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    try {
      log(`Cache size: ${formatBytes(statSync(FRAGMENT_CACHE_FILE).size)}`);
    } catch {
      log("Cache size: unavailable");
    }
    log(`Cache fragments: ${successful.length} successful / ${rows.length} total`);
    for (const [status, count] of [...byStatus.entries()].sort()) {
      log(`  status:${status}: ${count}`);
    }
    for (const [kind, count] of [...byKind.entries()].sort()) {
      log(`  kind:${kind}: ${count}`);
    }
    for (const [source, count] of [...bySource.entries()].sort()) {
      log(`  ${source}: ${count}`);
    }
    if (rows.some((row) => row.status !== "success")) {
      log("Some cached fragments are not reusable; the next report can reparse or replace them.");
    }
  } finally {
    await cache.close();
  }
}

async function runCacheRebuild(log: Log): Promise<void> {
  const cache = await rebuildFragmentCache();
  await cache.close();
  log("Rebuilt local Argus fragment cache.");
}

async function main() {
  printBanner();
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (flags.help) { process.stdout.write(HELP); return; }
  const log: Log = (s) => process.stderr.write(s + "\n");
  if (flags.command === "push") await runPush(flags, log);
  else if (flags.command === "login") await runLogin(flags, log);
  else if (flags.command === "cache-status") await runCacheStatus(log);
  else if (flags.command === "cache-rebuild") await runCacheRebuild(log);
  else if (flags.command === "analyze") await runAnalyze(flags, log);
  else await runReport(flags, log, isBareInvocation(argv));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
