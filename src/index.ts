#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
import { vendoredChartJs } from "./chartjs.ts";
import { loadPlugins } from "./inventory.ts";
import { parseAll, type TranscriptSource } from "./parse.ts";
import { renderHtml } from "./report.ts";
import { claudeAvailable, heuristicSummary, llmSummaries } from "./summarize.ts";
import { detectOrg, detectUser, pushSnapshot, SCHEMA_VERSION } from "./push.ts";
import type { PushCredentials } from "./push.ts";
import { ACCESS_TOKEN_FILE } from "./paths.ts";
import type { Dashboard } from "./aggregate.ts";
import type { SessionMeta } from "./types.ts";

interface Flags {
  command: "report" | "push" | "login";
  source: "all" | TranscriptSource;
  since?: string;
  until?: string;
  project?: string;
  out: string;
  summarize: boolean;
  summarizeModel?: string;
  open: boolean;
  json: boolean;
  help: boolean;
  // push & login
  endpoint?: string;
  user?: string;
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    command: "report",
    source: "all",
    out: "argus-report.html",
    summarize: false,
    open: false,
    json: false,
    help: false,
    endpoint: process.env.ARGUS_ENDPOINT || "https://argus.agentdeployment.co",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case "report": f.command = "report"; break;
      case "push": f.command = "push"; break;
      case "login": f.command = "login"; break;
      case "--source": f.source = parseSource(next()); break;
      case "--since": f.since = next(); break;
      case "--until": f.until = next(); break;
      case "--project": f.project = next(); break;
      case "--out": case "-o": f.out = next() || f.out; break;
      case "--summarize": f.summarize = true; break;
      case "--summarize-model": f.summarizeModel = next(); break;
      case "--open": f.open = true; break;
      case "--json": f.json = true; break;
      case "--endpoint": f.endpoint = next(); break;
      case "--user": f.user = next(); break;
      case "--help": case "-h": f.help = true; break;
      default:
        if (a.startsWith("-")) { console.error(`Unknown flag: ${a}`); process.exit(2); }
    }
  }
  return f;
}

function parseSource(value: string | undefined): "all" | TranscriptSource {
  if (value === "all" || value === "claude" || value === "codex") return value;
  console.error(`Invalid --source: ${value ?? ""} (expected claude, codex, or all)`);
  process.exit(2);
}

function sourcesFor(source: "all" | TranscriptSource): TranscriptSource[] {
  return source === "all" ? ["claude", "codex"] : [source];
}

const HELP = `argus — audit your Claude Code and Codex usage

Usage:
  argus [report] [options]    build the local HTML dashboard (default)
  argus login [options]       login via Cloudflare Access SSO in your browser
  argus push [options]        push your usage snapshot to a team Worker

Report options:
  --source <claude|codex|all>
                            transcript source to parse (default: all)
  --since <YYYY-MM-DD>     only include messages on/after this date
  --until <YYYY-MM-DD>     only include messages on/before this date
  --project <substr>       only include sessions whose project path matches substr
  -o, --out <file>         output HTML path (default: argus-report.html)
  --summarize              generate per-session LLM summaries via headless 'claude -p' (cached)
  --summarize-model <id>   model for summaries (e.g. claude-haiku-4-5-20251001)
  --open                   open the report in the default browser when done (macOS)
  --json                   write raw aggregate JSON to --out instead of HTML

Login options:
  --endpoint <url>         SSO service URL     (default: https://argus.agentdeployment.co)

Push options (also honors --since/--until/--project/--summarize):
  --endpoint <url>         Worker base URL     (or env ARGUS_ENDPOINT, default: https://argus.agentdeployment.co)
  --user <id>              override the user id (default: git email, else \$USER@host)

  -h, --help               show this help

Reads transcripts from ~/.claude/projects (override dir via CLAUDE_CONFIG_DIR) and
~/.codex/sessions (override dir via CODEX_HOME or CODEX_CONFIG_DIR).
`;

function withinRange(date: string, since?: string, until?: string): boolean {
  if (since && date < since) return false;
  if (until && date > until) return false;
  return true;
}

type Log = (s: string) => void;

/** Parse transcripts, apply filters, summarize, and build the aggregate dashboard. */
function buildDashboard(flags: Flags, log: Log): Dashboard {
  log("Parsing transcripts…");
  const parsed = parseAll({ sources: sourcesFor(flags.source) });

  // Apply filters.
  if (flags.since || flags.until || flags.project) {
    parsed.messages = parsed.messages.filter(
      (m) =>
        withinRange(m.date, flags.since, flags.until) &&
        (!flags.project || m.cwd.includes(flags.project)),
    );
    const keep = new Set(parsed.messages.map((m) => m.sessionId));
    for (const sid of [...parsed.sessions.keys()]) if (!keep.has(sid)) parsed.sessions.delete(sid);
  }

  log(`  ${parsed.messages.length} assistant messages across ${parsed.sessions.size} sessions.`);

  const plugins = loadPlugins();

  // Build per-session last-timestamp + heuristic summaries first.
  const lastTs = new Map<string, number>();
  const factsBySession = new Map<string, { firstPrompt: string; topSkills: string[]; toolCounts: Record<string, number>; filesTouched: string[] }>();
  for (const m of parsed.messages) {
    lastTs.set(m.sessionId, Math.max(lastTs.get(m.sessionId) || 0, m.ts));
    const f = factsBySession.get(m.sessionId) || {
      firstPrompt: parsed.sessions.get(m.sessionId)?.firstPrompt || "",
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
      log(`Summarizing ${parsed.sessions.size} sessions via claude -p (cached; incremental)…`);
      const targets: { meta: SessionMeta; lastTs: number }[] = [];
      for (const meta of parsed.sessions.values()) {
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

  const dash = aggregate(parsed, plugins, summaries);
  dash.generatedAtMs = Date.now();
  return dash;
}

function summary(dash: Dashboard): string {
  return (
    `${dash.totals.sessions} sessions · ${dash.totals.messages} msgs · ` +
    `${(dash.totals.total / 1e6).toFixed(2)}M tokens · $${dash.totals.cost.toFixed(2)} est.`
  );
}

async function runReport(flags: Flags, log: Log): Promise<void> {
  const dash = buildDashboard(flags, log);
  const outPath = resolve(flags.out);
  if (flags.json) {
    writeFileSync(outPath, JSON.stringify(dash, null, 2));
  } else {
    writeFileSync(outPath, renderHtml(dash, { chartJs: vendoredChartJs() }));
  }
  log(`Wrote ${outPath}`);
  log(`Totals: ${summary(dash)}`);
  if (flags.open && !flags.json) spawnSync("open", [outPath]);
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
  const org = detectOrg(undefined, user);

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

  const dash = buildDashboard(flags, log);
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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { process.stdout.write(HELP); return; }
  const log: Log = (s) => process.stderr.write(s + "\n");
  if (flags.command === "push") await runPush(flags, log);
  else if (flags.command === "login") await runLogin(flags, log);
  else await runReport(flags, log);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
