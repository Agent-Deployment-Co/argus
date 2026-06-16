#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand, runMain, showUsage } from "citty";
import type { ArgsDef, CommandContext, ParsedArgs } from "citty";
import { loginWithManagedOAuth, saveAccessTokenCache } from "./auth.ts";
import { printBanner } from "./banner.ts";
import { scanStore } from "./parse-incremental.ts";
import { RENDERERS, type OutputFormat } from "./renderers.ts";
import { ACCESS_TOKEN_FILE, STORE_FILE } from "./paths.ts";
import { buildDashboard, summaryLine, type Log, type BuildDashboardOptions } from "./dashboard-builder.ts";
import { startServer } from "./serve.ts";
import { openStore } from "./store.ts";
import { runIndex, runIndexDelete, runIndexRebuild, runIndexRefresh } from "./index-ops.ts";
import { pushSnapshotForOpts, resolveCredentials, watchIndex, watchSync, type PushLoopOptions } from "./watch.ts";
import { runRun } from "./run.ts";
import { buildOptions, syncOptions, toSource } from "./cli-options.ts";
import pkg from "../package.json" with { type: "json" };

const DEFAULT_ENDPOINT = "https://argus.agentdeployment.co";
const DEFAULT_PORT = Number(process.env.ARGUS_PORT) || 4242;

// `buildDashboard` takes `BuildDashboardOptions` (from dashboard-builder); the command-specific
// option shapes below layer each subcommand's own flags on top of it. The shared store-selection
// (`SyncOptions`) and build (`buildOptions`) shapes live in cli-options.ts so the extracted command
// bodies and the long-running loops can reuse them.
interface ReportOptions extends BuildDashboardOptions {
  out: string;
  json: boolean;
  open: boolean;
}

interface ServeOptions extends BuildDashboardOptions {
  port: number;
  open: boolean;
}

const log: Log = (s) => process.stderr.write(s + "\n");

/** Build an AbortController wired to one-shot SIGINT/SIGTERM handlers, for the `--watch` commands. */
function abortOnSignals(): AbortController {
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return ac;
}

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

/** The first bare (non-flag) token in rawArgs — the position citty uses to pick a subcommand. Mirrors
 *  citty's own findSubCommandIndex, skipping the value of a `--flag value` string flag. Returns
 *  undefined when there's no positional token. citty runs a parent command's `run` *even after*
 *  dispatching to a subcommand, so a parent with both must check this and bail when one matched
 *  (citty throws "Unknown command" before the parent run if the token isn't a real subcommand, so a
 *  present token here always means a subcommand handled the invocation). */
function dispatchedSubcommand(ctx: CommandContext<any>): string | undefined {
  const def = (ctx.cmd.args ?? {}) as ArgsDef;
  const valueFlags = new Set<string>();
  for (const [name, rawSpec] of Object.entries(def)) {
    const spec = rawSpec as { type?: string; alias?: string | string[] };
    if (spec.type !== "string" && spec.type !== "enum") continue;
    const aliases = Array.isArray(spec.alias) ? spec.alias : spec.alias ? [spec.alias] : [];
    for (const variant of [name, ...aliases].flatMap(nameVariants)) valueFlags.add(variant);
  }
  const raw = ctx.rawArgs;
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i]!;
    if (tok === "--") return undefined;
    if (tok.startsWith("-") && tok !== "-") {
      const body = tok.slice(tok.startsWith("--") ? 2 : 1);
      if (!body.includes("=") && valueFlags.has(body)) i++; // skip the flag's value
      continue;
    }
    return tok;
  }
  return undefined;
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
  log(`Totals: ${summaryLine(dash)}`);
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

/** One-shot upload of the current snapshot to the team dashboard (the bare `argus sync`). */
async function runPushOnce(opts: PushLoopOptions, log: Log): Promise<void> {
  const credentials = await resolveCredentials(opts.endpoint, log);
  if (!credentials) {
    log("Not logged in. Run `argus login` first to upload to the team dashboard.");
    process.exit(1);
  }

  const res = await pushSnapshotForOpts(opts, credentials, log);
  if (res.ok) {
    log(`✓ Uploaded (${res.status}). ${res.body.slice(0, 200)}`);
  } else if (res.isAccessChallenge) {
    log(`✗ Upload failed (${res.status}): you're signed out or your session expired.`);
    log("  Run `argus login`, then try again.");
    process.exit(1);
  } else {
    log(`✗ Upload failed (${res.status}): ${res.body.slice(0, 400)}`);
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
    log("Run `argus index rebuild --force` to rebuild it from your transcripts.");
    process.exit(1);
  }

  // Count every session the store actually holds, grouped by where it came from, so the per-source
  // lines and the total reconcile with what `argus index` reports (which counts the whole store).
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
    log("No sessions yet. Run `argus index` once you've used Claude Code, Claude Cowork, Codex, or Gemini.");
    return;
  }
  for (const line of lines) log(line);
  if (lines.length > 1) log(`Total: ${total} sessions`);
  if (totalArchived) {
    log(`Kept after leaving disk: ${totalArchived} session${totalArchived === 1 ? "" : "s"} · remove with \`argus index delete --archived\``);
  }
  if (pending) log("Run `argus index` to pick up new and changed sessions.");
}

// ---------------------------------------------------------------------------
// CLI definition (citty). Each subcommand declares its own flags; --help scopes
// to that subcommand automatically and flag types flow into the run handlers.
// ---------------------------------------------------------------------------

/** Source selection — shared by report, serve, sync, run, and the `index` commands.
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

/** Date/project filters — shared by report, serve, and sync. */
const filterArgs = {
  since: { type: "string", description: "Only include messages on/after this date", valueHint: "YYYY-MM-DD" },
  until: { type: "string", description: "Only include messages on/before this date", valueHint: "YYYY-MM-DD" },
  project: { type: "string", description: "Only include sessions whose directory contains this text", valueHint: "substr" },
} as const;

/** Summary generation — shared by report, serve, and sync. */
const summarizeArgs = {
  summarize: { type: "boolean", default: false, description: "Generate per-session summaries via headless 'claude -p' (cached)" },
  "summarize-model": { type: "string", description: "Model for summaries (e.g. claude-haiku-4-5-20251001)", valueHint: "id" },
} as const;

/** Inputs shared by report, serve, and sync (everything `buildDashboard` reads). */
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

// `argus index` — the local store maintenance group. The bare command does an incremental read;
// `--watch` keeps it running on an interval; the subcommands cover the destructive/scoped operations.
const indexRebuild = defineCommand({
  meta: { name: "rebuild", description: "rebuild the store from your transcripts (drops sessions no longer on disk)" },
  args: {
    ...sourceArg,
    ...agentsViewArgs,
    force: { type: "boolean", default: false, description: "Skip the confirmation prompt (for scripts/CI)" },
  },
  run: handler((args) => runIndexRebuild({ ...syncOptions(args), force: args.force }, log)),
});

const indexRefresh = defineCommand({
  meta: { name: "refresh", description: "re-read all transcripts from disk (keeps sessions no longer on disk)" },
  args: { ...sourceArg, ...agentsViewArgs },
  run: handler((args) => runIndexRefresh(syncOptions(args), log)),
});

const indexDelete = defineCommand({
  meta: { name: "delete", description: "permanently remove sessions from the local store" },
  args: {
    id: { type: "positional", required: false, description: "session id(s) to remove" },
    ...sourceArg,
    archived: { type: "boolean", default: false, description: "Remove all sessions no longer on disk, optionally scoped by --source" },
  },
  run: handler((args) => runIndexDelete({ source: toSource(args.source), archived: args.archived, ids: args._ }, log)),
});

const index = defineCommand({
  meta: { name: "index", description: "read new and changed sessions into the local store" },
  args: {
    ...sourceArg,
    ...agentsViewArgs,
    watch: { type: "boolean", default: false, description: "Keep reading new and changed sessions on an interval" },
    interval: { type: "string", default: "5", description: "Minutes between reads (with --watch)", valueHint: "N" },
  },
  subCommands: { rebuild: indexRebuild, refresh: indexRefresh, delete: indexDelete },
  run: (ctx) => {
    // citty also runs this parent `run` after a subcommand handled the call — bail in that case.
    if (dispatchedSubcommand(ctx) !== undefined) return Promise.resolve();
    validateArgs(ctx);
    return guard(async () => {
      const args = ctx.args;
      if (args.watch) {
        const ac = abortOnSignals();
        await watchIndex({ ...syncOptions(args), intervalMin: Number(args.interval) || 5 }, log, ac.signal);
      } else {
        await runIndex(syncOptions(args), log);
      }
    });
  },
});

const status = defineCommand({
  meta: { name: "status", description: "show the local store path + per-source counts" },
  run: handler(() => runStatus(log)),
});

const login = defineCommand({
  meta: { name: "login", description: "login via Cloudflare Access SSO in your browser" },
  args: {
    endpoint: { type: "string", default: process.env.ARGUS_ENDPOINT || DEFAULT_ENDPOINT, description: "Service URL for login (env ARGUS_ENDPOINT)", valueHint: "url" },
  },
  run: handler((args) => runLogin({ endpoint: args.endpoint }, log)),
});

const sync = defineCommand({
  meta: { name: "sync", description: "upload your usage snapshot to a team dashboard" },
  args: {
    ...buildArgs,
    endpoint: { type: "string", default: process.env.ARGUS_ENDPOINT || DEFAULT_ENDPOINT, description: "Service URL for uploads (env ARGUS_ENDPOINT)", valueHint: "url" },
    user: { type: "string", description: "Override the user id (default: git email, else $USER@host)", valueHint: "id" },
    org: { type: "string", default: process.env.ARGUS_ORG, description: "Override the org (env ARGUS_ORG)", valueHint: "id" },
    watch: { type: "boolean", default: false, description: "Keep uploading on an interval" },
    interval: { type: "string", default: "5", description: "Minutes between uploads (with --watch)", valueHint: "N" },
  },
  run: handler(async (args) => {
    const base: PushLoopOptions = { ...buildOptions(args), endpoint: args.endpoint, user: args.user, org: args.org };
    if (args.watch) {
      const ac = abortOnSignals();
      await watchSync({ ...base, intervalMin: Number(args.interval) || 5, onUnauthenticated: "fail" }, log, ac.signal);
    } else {
      await runPushOnce(base, log);
    }
  }),
});

const runCmd = defineCommand({
  meta: { name: "run", description: "keep the dashboard live: index, serve, and upload in one process" },
  args: {
    ...sourceArg,
    ...agentsViewArgs,
    port: { type: "string", alias: "p", default: String(DEFAULT_PORT), description: "Local port to listen on (env ARGUS_PORT)", valueHint: "N" },
    "index-interval": { type: "string", default: "5", description: "Minutes between transcript reads", valueHint: "N" },
    "sync-interval": { type: "string", default: "5", description: "Minutes between uploads", valueHint: "N" },
    endpoint: { type: "string", default: process.env.ARGUS_ENDPOINT || DEFAULT_ENDPOINT, description: "Service URL for uploads (env ARGUS_ENDPOINT)", valueHint: "url" },
  },
  run: handler((args) =>
    runRun(
      {
        ...syncOptions(args),
        port: Number(args.port) || DEFAULT_PORT,
        indexIntervalMin: Number(args["index-interval"]) || 5,
        syncIntervalMin: Number(args["sync-interval"]) || 5,
        endpoint: args.endpoint,
      },
      log,
    ),
  ),
});

const main = defineCommand({
  meta: {
    name: "argus",
    version: pkg.version,
    description: "audit your Claude Code, Claude Cowork, Codex, and Gemini CLI usage",
  },
  // No root flags and no default command: every flag belongs to a specific subcommand, so running
  // `argus` with no subcommand falls through to the usage/help. Sessions stay in the local store
  // even after their transcripts age off disk; only `argus index delete` removes them.
  subCommands: { report, serve, index, sync, run: runCmd, status, login },
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
