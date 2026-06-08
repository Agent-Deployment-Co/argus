#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { aggregate } from "./aggregate.ts";
import { vendoredChartJs } from "./chartjs.ts";
import { loadPlugins } from "./inventory.ts";
import { parseAll, type TranscriptSource } from "./parse.ts";
import { renderHtml } from "./report.ts";
import { claudeAvailable, heuristicSummary, llmSummaries } from "./summarize.ts";
import { detectOrg, detectUser, pushSnapshot, SCHEMA_VERSION } from "./push.ts";
import type { Dashboard } from "./aggregate.ts";
import type { SessionMeta } from "./types.ts";

interface Flags {
  command: "report" | "push";
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
  // push
  endpoint?: string;
  token?: string;
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
    help: false,
    endpoint: process.env.ARGUS_ENDPOINT,
    token: process.env.ARGUS_TOKEN,
    org: process.env.ARGUS_ORG,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case "report": f.command = "report"; break;
      case "push": f.command = "push"; break;
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
      case "--token": f.token = next(); break;
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

Push options (also honors --since/--until/--project/--summarize):
  --endpoint <url>         Worker base URL     (or env ARGUS_ENDPOINT)
  --token <token>          your org's bearer token (or env ARGUS_TOKEN)
  --user <id>              override the user id (default: git email, else \$USER@host)
  --org <id>               override the org    (default: email domain; or env ARGUS_ORG)

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

async function runPush(flags: Flags, log: Log): Promise<void> {
  if (!flags.endpoint) {
    log("! No endpoint. Pass --endpoint <url> or set ARGUS_ENDPOINT.");
    process.exit(2);
  }
  if (!flags.token) {
    log("! No token. Pass --token <token> or set ARGUS_TOKEN.");
    process.exit(2);
  }
  const user = detectUser(flags.user);
  const org = detectOrg(flags.org, user);
  const dash = buildDashboard(flags, log);
  log(`Pushing snapshot for "${user}" (org: ${org ?? "from token"}) → ${flags.endpoint}`);
  log(`  ${summary(dash)}`);
  const res = await pushSnapshot(flags.endpoint, flags.token, {
    schemaVersion: SCHEMA_VERSION,
    org,
    user,
    generatedAtMs: dash.generatedAtMs,
    dashboard: dash,
  });
  if (res.ok) {
    log(`✓ Pushed (${res.status}). ${res.body.slice(0, 200)}`);
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
  else await runReport(flags, log);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
