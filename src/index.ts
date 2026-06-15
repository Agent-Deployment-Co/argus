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
import { openStore, rebuildStore } from "./store.ts";

interface Flags {
  command: "report" | "push" | "login" | "status" | "reindex" | "sync" | "forget";
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
  /** reindex: drop the whole store (loses archived/off-disk sessions) instead of re-deriving in place. */
  force: boolean;
  /** forget: target all archived (off-disk) sessions instead of explicit ids. */
  archived: boolean;
  /** Positional args (e.g. session ids for `forget`). */
  positionals: string[];
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
    force: false,
    archived: false,
    positionals: [],
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
      case "forget": f.command = "forget"; break;
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
      case "--force": f.force = true; break;
      case "--archived": f.archived = true; break;
      case "--help": case "-h": f.help = true; break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
        else f.positionals.push(a);
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
  argus                       terminal overview (no options; just run it)
  argus report [options]      build the local HTML (or --json) dashboard
  argus sync [options]        read new and changed sessions into the local store
  argus reindex [options]     re-read all transcripts from disk (keeps archived); --force to wipe
  argus status                show the local store path + per-source counts
  argus forget <id>… | --archived   permanently remove sessions from the local store
  argus login [options]       login via Cloudflare Access SSO in your browser
  argus push [options]        push your usage snapshot to a team Worker

Sessions stay in the local store even after their transcripts age off disk (Claude Code keeps
~30 days): they're kept and marked "archived" rather than deleted. \`argus forget\` is the only
thing that removes them.

Source selection (report, push, sync, reindex, forget --archived):
  --source <claude|codex|gemini|all>   transcript source(s) (default: all)
  --agentsview             auto-detect AgentsView imports (default)
  --no-agentsview          disable AgentsView discovery/import
  --agentsview-db <path>   read a specific AgentsView sessions.db

Store maintenance (reindex, forget):
  --force                  reindex: drop the whole store, including archived (off-disk) sessions
  --archived               forget: target all archived sessions (optionally scoped by --source)

Filters (report, push):
  --since <YYYY-MM-DD>     only include messages on/after this date
  --until <YYYY-MM-DD>     only include messages on/before this date
  --project <substr>       only include sessions whose cwd contains substr

Report output (report only):
  -o, --out <file>         output path (default: argus-report.html)
  --json                   write raw aggregate JSON to --out instead of HTML
  --open                   open the report in the default browser when done (macOS)

Summaries (report, push):
  --summarize              generate per-session LLM summaries via headless 'claude -p' (cached)
  --summarize-model <id>   model for summaries (e.g. claude-haiku-4-5-20251001)

Login / push:
  --endpoint <url>         service URL for login & push
                           (env ARGUS_ENDPOINT, default: https://argus.agentdeployment.co)
  --user <id>              push: override the user id (default: git email, else \$USER@host)
  --org <id>               push: override the org (env ARGUS_ORG)

  -h, --help               show this help

The local store path is shown by \`argus status\` (override its directory via
ARGUS_DATA_DIR). Transcripts are read from ~/.claude/projects (CLAUDE_CONFIG_DIR),
~/.codex/sessions (CODEX_HOME / CODEX_CONFIG_DIR), and ~/.gemini/tmp (GEMINI_CLI_HOME).
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

/** Diagnostics worth interrupting a report for: something that makes the result wrong or incomplete.
 *  A missing source root just means the user doesn't use that tool — not a problem to report.
 *  Routine notes (re-read files, AgentsView provenance) are left for `argus sync`. */
function reportProblems(diagnostics: ParserDiagnostic[]): ParserDiagnostic[] {
  return uniqueDiagnostics(diagnostics)
    .filter((entry) => entry.severity === "error" && entry.code !== "missing_root")
    .slice(0, 5);
}

/** Parse transcripts, apply filters, summarize, and build the aggregate dashboard. */
async function buildDashboard(flags: Flags, log: Log): Promise<Dashboard> {
  log("Reading transcripts…");
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
  // Keep reports quiet: only call out problems that affect the result (and explain a degraded read).
  if (store.stats?.fallback) log(`  ${syncStatsSummary(store.stats, store.diagnostics)}`);
  for (const entry of reportProblems(store.diagnostics)) log(`  ! ${entry.message}`);

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
    const archived = scan.archivedCount ? ` (+${scan.archivedCount} archived)` : "";
    log(`  ${scan.source}: ${scan.sessionCount} sessions${archived} · last synced ${when} · ${state}`);
  }
  // Total archived across all owners (includes import producers like AgentsView, which `scanStore`
  // doesn't cover). These are retained, off-disk sessions that re-deriving from disk can't recover.
  try {
    const store = await openStore();
    try {
      const archivedAll = await store.listArchived();
      if (archivedAll.length) {
        const n = archivedAll.length;
        log(`Kept after leaving disk: ${n} session${n === 1 ? "" : "s"} · remove with \`argus forget --archived\``);
      }
    } finally {
      await store.close();
    }
  } catch {
    // best-effort; the scan above already reported store availability
  }
  if (scans.some((scan) => !scan.upToDate)) log("Run `argus sync` to pick up new and changed sessions.");
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
    log(`Local store now has ${parsed.sessions.size} sessions and ${parsed.messages.length} messages.`);
  } finally {
    await store.close();
  }
}

async function runReindex(flags: Flags, log: Log): Promise<void> {
  if (flags.force) {
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
  await runSync(flags, log);
}

async function runForget(flags: Flags, log: Log): Promise<void> {
  const store = await openStore();
  try {
    const targets = flags.archived
      ? await store.listArchived(flags.source === "all" ? undefined : flags.source)
      : flags.positionals;
    if (!targets.length) {
      log(
        flags.archived
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
  else if (flags.command === "forget") await runForget(flags, log);
  else await runReport(flags, log, isBareInvocation(argv));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
