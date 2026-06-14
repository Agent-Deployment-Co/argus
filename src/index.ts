#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { isBareInvocation } from "./console-report.ts";
import { loadPlugins } from "./inventory.ts";
import type { TranscriptSource } from "./parse.ts";
import { syncStatsSummary, scanStore } from "./parse-incremental.ts";
import { openSessionStore } from "./session-store.ts";
import { RENDERERS, type OutputFormat } from "./renderers.ts";
import { claudeAvailable, heuristicSummary, llmSummaries } from "./summarize.ts";
import { detectOrg, detectUser, pushSnapshot, SCHEMA_VERSION } from "./push.ts";
import type { PushCredentials } from "./push.ts";
import { ACCESS_TOKEN_FILE, STORE_FILE } from "./paths.ts";
import type { Dashboard } from "./aggregate.ts";
import type { SessionMeta } from "./types.ts";
import type { ParserDiagnostic } from "./store-contract.ts";
import { rebuildStore } from "./store.ts";

interface Flags {
  command: "report" | "push" | "login" | "status" | "reindex" | "sync";
  source: "all" | TranscriptSource;
  since?: string;
  until?: string;
  project?: string;
  out: string;
  summarize: boolean;
  summarizeModel?: string;
  open: boolean;
  json: boolean;
  agentsView: "auto" | "off";
  agentsViewDatabasePath?: string;
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
    agentsView: "auto",
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
      case "status": f.command = "status"; break;
      case "reindex": f.command = "reindex"; break;
      case "sync": f.command = "sync"; break;
      case "--source": f.source = parseSource(next()); break;
      case "--since": f.since = next(); break;
      case "--until": f.until = next(); break;
      case "--project": f.project = next(); break;
      case "--out": case "-o": f.out = next() || f.out; break;
      case "--summarize": f.summarize = true; break;
      case "--summarize-model": f.summarizeModel = next(); break;
      case "--open": f.open = true; break;
      case "--json": f.json = true; break;
      case "--agentsview": f.agentsView = "auto"; break;
      case "--no-agentsview": f.agentsView = "off"; break;
      case "--agentsview-db": f.agentsViewDatabasePath = next(); break;
      case "--endpoint": f.endpoint = next(); break;
      case "--user": f.user = next(); break;
      case "--org": f.org = next(); break;
      case "--help": case "-h": f.help = true; break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
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
  argus login [options]       login via Cloudflare Access SSO in your browser
  argus push [options]        push your usage snapshot to a team Worker
  argus status                show the local store path + per-source coverage
  argus sync                  bring the local store up to date (index new/changed sessions)
  argus reindex               rebuild the local store from scratch

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
  --agentsview             auto-detect AgentsView imports (default)
  --no-agentsview          disable AgentsView discovery/import
  --agentsview-db <path>   read a specific AgentsView sessions.db

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

type Log = (s: string) => void;

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

function logSyncDiagnostics(
  diagnostics: ParserDiagnostic[],
  flags: Flags,
  log: Log,
): void {
  const surfacedInfo = new Set([
    "agentsview_import_used",
    "agentsview_import_merged",
    "reindex_file_changed",
    "reindex_parser_version_changed",
    "reindex_contract_version_changed",
    "reindex_fragment_unavailable",
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
  if (omitted > 0) log(`  i ${omitted} additional store diagnostics omitted.`);
}

/** Parse transcripts, apply filters, summarize, and build the aggregate dashboard. */
async function buildDashboard(flags: Flags, log: Log): Promise<Dashboard> {
  log("Parsing transcripts…");
  const store = openSessionStore({
    sources: sourcesFor(flags.source),
    agentsView: flags.agentsView,
    agentsViewDatabasePath: flags.agentsViewDatabasePath,
  });
  let parseResult;
  try {
    parseResult = await store.read({
      since: flags.since,
      until: flags.until,
      projectSubstring: flags.project,
    });
  } finally {
    await store.close();
  }
  if (store.stats) log(`  ${syncStatsSummary(store.stats, store.diagnostics)}`);
  logSyncDiagnostics(store.diagnostics, flags, log);

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
  return dash;
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
  const format: OutputFormat = consoleOnly ? "console" : flags.json ? "json" : "html";
  const rendered = RENDERERS[format](dash);
  if (rendered.toStdout) {
    process.stdout.write(rendered.content);
    return;
  }
  const outPath = resolve(flags.out);
  writeFileSync(outPath, rendered.content);
  log(`Wrote ${outPath}`);
  log(`Totals: ${summary(dash)}`);
  if (flags.open && format === "html") spawnSync("open", [outPath]);
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

async function runStatus(log: Log): Promise<void> {
  log(`Store path: ${STORE_FILE}`);
  try {
    log(`Store size: ${formatBytes(statSync(STORE_FILE).size)}`);
  } catch {
    log("Store size: unavailable");
  }
  let scans;
  try {
    scans = await scanStore({ sources: ["claude", "codex", "gemini"] });
  } catch (err) {
    log(`Store unavailable: ${err instanceof Error ? err.message : String(err)}`);
    log("Run `argus reindex` to rebuild the local store.");
    process.exit(1);
  }
  for (const scan of scans) {
    const when = scan.lastSyncAtMs ? new Date(scan.lastSyncAtMs).toISOString() : "never";
    const state = scan.upToDate ? "up to date" : "pending changes";
    log(`  ${scan.source}: ${scan.sessionCount} sessions · last synced ${when} · ${state}`);
  }
  if (scans.some((scan) => !scan.upToDate)) log("Run `argus sync` to index pending changes.");
}

/** Bring the store up to date for the requested sources (producers reconcile + materialize). */
async function runSync(flags: Flags, log: Log): Promise<void> {
  const store = openSessionStore({
    sources: sourcesFor(flags.source),
    agentsView: flags.agentsView,
    agentsViewDatabasePath: flags.agentsViewDatabasePath,
  });
  try {
    const parsed = await store.read({});
    if (store.stats) log(syncStatsSummary(store.stats, store.diagnostics));
    log(`Store now holds ${parsed.sessions.size} sessions · ${parsed.messages.length} messages.`);
  } finally {
    await store.close();
  }
}

async function runReindex(flags: Flags, log: Log): Promise<void> {
  const store = await rebuildStore();
  await store.close();
  log("Rebuilt the local Argus store. Indexing…");
  await runSync(flags, log);
}

async function main() {
  printBanner();
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (flags.help) { process.stdout.write(HELP); return; }
  const log: Log = (s) => process.stderr.write(s + "\n");
  if (flags.command === "push") await runPush(flags, log);
  else if (flags.command === "login") await runLogin(flags, log);
  else if (flags.command === "status") await runStatus(log);
  else if (flags.command === "reindex") await runReindex(flags, log);
  else if (flags.command === "sync") await runSync(flags, log);
  else await runReport(flags, log, isBareInvocation(argv));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
