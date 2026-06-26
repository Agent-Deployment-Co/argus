#!/usr/bin/env bun
import { statSync } from "node:fs";
import { defineCommand, runMain, showUsage } from "citty";
import type { ArgsDef, CommandContext, ParsedArgs } from "citty";
import { loginWithManagedOAuth, saveAccessTokenCache } from "./auth.ts";
import { printBanner } from "./banner.ts";
import { scanStore } from "./indexing/pipeline.ts";
import { ACCESS_TOKEN_FILE, STORE_FILE } from "./paths.ts";
import { ALL_SOURCES, type Log, type BuildDashboardOptions } from "./reporting/dashboard-builder.ts";
import { startServer } from "./api/serve.ts";
import { openStore } from "./store/store.ts";
import { runIndex, runIndexDelete, runIndexRebuild, runIndexRefresh } from "./index-ops.ts";
import { pushSnapshotForOpts, resolveCredentials, watchIndex, watchSync, type PushLoopOptions } from "./watch.ts";
import { runRun } from "./run.ts";
import { buildOptions, syncOptions, toSource } from "./cli-options.ts";
import { loadConfig, resolveTaskExtraction, type ResolvedTaskExtraction } from "./config.ts";
import { defaultSecretStore, isSecretName, resolveApiKey, SECRET_NAMES } from "./secrets.ts";
import { complete } from "./llm/index.ts"; // TEMP (argus llm)
import pkg from "../package.json" with { type: "json" };

const DEFAULT_ENDPOINT = "https://argus.agentdeployment.co";
const DEFAULT_PORT = Number(process.env.ARGUS_PORT) || 4242;

// `buildDashboard` takes `BuildDashboardOptions` (from dashboard-builder); the command-specific
// option shapes below layer each subcommand's own flags on top of it. The shared store-selection
// (`SyncOptions`) and build (`buildOptions`) shapes live in cli-options.ts so the extracted command
// bodies and the long-running loops can reuse them.
interface ServeOptions {
  port: number;
  open: boolean;
}

const log: Log = (s) => process.stderr.write(s + "\n");

/** Parse the tri-state `--extract-tasks` flag: unset → undefined (defer to argus.json), else the
 *  explicit boolean override. Anything other than true/false is a usage error. */
function toExtractTasksOverride(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  console.error(`Invalid --extract-tasks: ${value} (expected true or false)`);
  process.exit(2);
}

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

async function runServe(opts: ServeOptions, log: Log): Promise<void> {
  await startServer(
    {
      port: opts.port,
      open: opts.open,
      // serve shows the whole store; it takes no source/date filters. It's a pure reader: read the
      // already-materialized store, never reconcile/materialize on a page load. Writing on read
      // silently destroyed extracted tasks (and firstPrompt) for any session whose transcript changed
      // since the last index. The store is maintained by `index` / `argus run`. See #98.
      // includeSessions:false — the web app reads the per-session array from the paginated
      // /api/sessions resource, so it's omitted from the bulk /api/snapshot payload.
      build: { source: "all", readOnly: true, includeSessions: false },
      // Per-session reindex (POST /api/sessions/:id/reindex) honors the argus.json task-extraction
      // setting (flag > env > argus.json > default), resolved here from config rather than a CLI flag.
      taskExtraction: taskExtractionOptions({}),
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
  if (res.skipped) {
    log(res.body); // nothing was uploaded (e.g. a local-only source); not an error
  } else if (res.ok) {
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
    scans = await scanStore({ sources: ALL_SOURCES });
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

/** Source selection — shared by serve, sync, run, and the `index` commands.
 *  Declared as a string (not enum) so citty's flag inference stays intact; the value set is
 *  validated by `toSource`. */
const sourceArg = {
  source: {
    type: "string",
    default: "all",
    description: "Transcript source: claude, codex, gemini, cowork, claude-chat, or all",
    valueHint: "claude|codex|gemini|cowork|claude-chat|all",
  },
} as const;

/** Date/project filters — shared by serve and sync. */
const filterArgs = {
  since: { type: "string", description: "Only include messages on/after this date", valueHint: "YYYY-MM-DD" },
  until: { type: "string", description: "Only include messages on/before this date", valueHint: "YYYY-MM-DD" },
  project: { type: "string", description: "Only include sessions whose directory contains this text", valueHint: "substr" },
} as const;

// Task extraction options for web/session-screen extraction. Flags carry no env-var defaults: an
// unset flag resolves to `undefined` so the config resolver can honor CLI flag > env > argus.json >
// default in one place (see resolveTaskExtraction in config.ts).
const taskArgs = {
  "task-provider": {
    type: "string",
    description: "Task extractor: claude, command, or off (env ARGUS_TASK_PROVIDER)",
    valueHint: "claude|command|off",
  },
  "task-model": {
    type: "string",
    description: "Model for task extraction when the provider supports it (env ARGUS_TASK_MODEL)",
    valueHint: "id",
  },
  "task-prompt": {
    type: "string",
    description: "Custom task extraction prompt (env ARGUS_TASK_PROMPT)",
    valueHint: "text",
  },
  "task-prompt-file": {
    type: "string",
    description: "Read the task extraction prompt from a file (env ARGUS_TASK_PROMPT_FILE)",
    valueHint: "path",
  },
  "task-command": {
    type: "string",
    description: "Command provider; reads prompt on stdin and writes task JSON to stdout (env ARGUS_TASK_COMMAND)",
    valueHint: "cmd",
  },
} as const;

/** The opt-in task-extraction override shared by the indexing commands (index, rebuild, refresh).
 *  Tri-state: unset defers to argus.json; true/false overrides it for the run (see #93). */
const extractTasksArg = {
  "extract-tasks": {
    type: "string",
    description: "Extract tasks this run: true|false (overrides argus.json). Omit to use the config setting.",
    valueHint: "true|false",
  },
} as const;

/** Print the full task-extraction debug stream to stdout (one-off runs; not applied under --watch). */
const debugArg = {
  debug: { type: "boolean", default: false, description: "Print full task-extraction debug output to stdout" },
} as const;

/** Inputs shared by serve and sync (everything `buildDashboard` reads). */
const buildArgs = {
  ...sourceArg,
  ...filterArgs,
} as const;

/** Resolve the effective task-extraction options for serve/run through the config chain (flag > env
 *  > argus.json > default). The `enabled` toggle is unused here — these commands extract on demand. */
function taskExtractionOptions(
  args: Record<string, unknown>,
  debugLog?: (message: string) => void,
): ResolvedTaskExtraction {
  return resolveTaskExtraction(args, loadConfig(), debugLog);
}

const serve = defineCommand({
  meta: { name: "serve", description: "serve the interactive dashboard at a local web address" },
  args: {
    port: { type: "string", alias: "p", default: String(DEFAULT_PORT), description: "Local port to listen on (env ARGUS_PORT)", valueHint: "N" },
    open: { type: "boolean", default: false, description: "Open the dashboard in your browser once it's ready (macOS)" },
  },
  run: handler((args) =>
    runServe(
      {
        port: Number(args.port) || DEFAULT_PORT,
        open: args.open,
      },
      log,
    ),
  ),
});

// `argus index` — the local store maintenance group. The bare command does an incremental read;
// `--watch` keeps it running on an interval; the subcommands cover the destructive/scoped operations.
const indexRebuild = defineCommand({
  meta: { name: "rebuild", description: "rebuild the store from your transcripts (drops sessions no longer on disk)" },
  args: {
    ...sourceArg,
    ...extractTasksArg,
    ...debugArg,
    force: { type: "boolean", default: false, description: "Skip the confirmation prompt (for scripts/CI)" },
  },
  run: handler((args) =>
    runIndexRebuild(
      { ...syncOptions(args), force: args.force },
      log,
      toExtractTasksOverride(args["extract-tasks"]),
      !!args.debug,
    ),
  ),
});

const indexRefresh = defineCommand({
  meta: { name: "refresh", description: "re-read transcripts from disk; pass session id(s) to refresh only those" },
  args: {
    id: { type: "positional", required: false, description: "session id(s) to refresh (space-separated); omit to refresh all" },
    ...sourceArg,
    ...extractTasksArg,
    ...debugArg,
  },
  run: handler((args) =>
    runIndexRefresh(
      {
        ...syncOptions(args),
        ids: args._,
        extractTasks: toExtractTasksOverride(args["extract-tasks"]),
        debug: !!args.debug,
      },
      log,
    ),
  ),
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
    ...extractTasksArg,
    ...debugArg,
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
      const extractTasks = toExtractTasksOverride(args["extract-tasks"]);
      if (args.watch) {
        const ac = abortOnSignals();
        await watchIndex({ ...syncOptions(args), intervalMin: Number(args.interval) || 5, extractTasks }, log, ac.signal);
      } else {
        await runIndex(syncOptions(args), log, extractTasks, !!args.debug);
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
    ...taskArgs,
    port: { type: "string", alias: "p", default: String(DEFAULT_PORT), description: "Local port to listen on (env ARGUS_PORT)", valueHint: "N" },
    "index-interval": { type: "string", default: "5", description: "Minutes between transcript reads", valueHint: "N" },
    "sync-interval": { type: "string", default: "5", description: "Minutes between uploads", valueHint: "N" },
    endpoint: { type: "string", default: process.env.ARGUS_ENDPOINT || DEFAULT_ENDPOINT, description: "Service URL for uploads (env ARGUS_ENDPOINT)", valueHint: "url" },
    "no-sync": { type: "boolean", default: false, description: "Skip uploads (index and serve only)" },
    debug: { type: "boolean", default: false, description: "Print task extraction debug logs to stdout" },
  },
  run: handler((args) => {
    const debugLog = args.debug
      ? (message: string) => process.stdout.write(message + "\n")
      : undefined;
    return runRun(
      {
        ...syncOptions(args),
        port: Number(args.port) || DEFAULT_PORT,
        indexIntervalMin: Number(args["index-interval"]) || 5,
        syncIntervalMin: Number(args["sync-interval"]) || 5,
        endpoint: args.endpoint,
        noSync: !!args["no-sync"],
        taskExtraction: taskExtractionOptions(args, debugLog),
      },
      log,
    );
  }),
});

// --- `argus secret`: manage stored LLM API keys (#132) ---

/** Prompt for a secret on the terminal, echoing each character as `*`. Raw-mode, so the raw value
 *  never reaches the screen or shell history; supports backspace and Ctrl-C. Pressing Enter on an empty
 *  line returns "" (the caller treats that as "skip"). Prompt and mask are written to stderr. */
function promptSecret(name: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(`Set ${name} [Enter to skip] 🔒: `);
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        const code = ch.charCodeAt(0);
        if (ch === "\n" || ch === "\r") {
          cleanup();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          cleanup();
          process.stderr.write("\n");
          reject(new Error("Cancelled."));
          return;
        }
        if (code === 127 || code === 8) {
          // Backspace / DEL — erase the last char and its mask.
          if (value.length) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else if (code >= 32) {
          // Printable — accumulate and echo a mask character.
          value += ch;
          process.stderr.write("*");
        }
        // Other control chars are ignored.
      }
    };
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

/** Read a secret value without exposing it in argv: piped stdin verbatim, or — when nothing is piped
 *  (stdin is a TTY) — a hidden interactive prompt. Returns "" when the user skips / pipes nothing. */
async function readSecretValue(name: string): Promise<string> {
  let value: string;
  if (process.stdin.isTTY) {
    value = await promptSecret(name);
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    value = Buffer.concat(chunks).toString("utf8");
  }
  return value.replace(/\r?\n$/, "");
}

function requireSecretName(args: Record<string, unknown>): string {
  const name = String(args.name ?? (Array.isArray(args._) ? args._[0] : "") ?? "");
  if (!isSecretName(name)) {
    throw new Error(`Unknown secret "${name}". Known secrets: ${SECRET_NAMES.join(", ")}.`);
  }
  return name;
}

const secretSet = defineCommand({
  meta: { name: "set", description: "store an API key (read from stdin, or prompted if interactive)" },
  args: { name: { type: "positional", required: true, description: "secret name (e.g. ANTHROPIC_API_KEY)" } },
  run: handler(async (args) => {
    const name = requireSecretName(args);
    const value = await readSecretValue(name);
    if (!value.trim()) {
      // Empty input (pressed Enter / piped nothing) means skip — leave any existing value untouched.
      log(`Skipped ${name} — nothing entered.`);
      return;
    }
    const store = defaultSecretStore();
    await store.set(name, value);
    const status = await store.describe(name);
    log(`Saved ${name} (${status.hint ?? "set"})`);
  }),
});

const secretRm = defineCommand({
  meta: { name: "rm", description: "remove a stored API key" },
  args: { name: { type: "positional", required: true, description: "secret name to remove" } },
  run: handler(async (args) => {
    const name = requireSecretName(args);
    const removed = await defaultSecretStore().delete(name);
    log(removed ? `Removed ${name}.` : `${name} was not set.`);
  }),
});

const secretStatus = defineCommand({
  meta: { name: "status", description: "show which API keys are stored (masked)" },
  run: handler(async () => {
    const store = defaultSecretStore();
    for (const name of SECRET_NAMES) {
      const status = await store.describe(name);
      log(`  ${name}: ${status.configured ? (status.hint ?? "set") : "not set"}`);
    }
  }),
});

const secret = defineCommand({
  meta: { name: "secret", description: "manage stored LLM API keys (kept in your OS keychain where available)" },
  subCommands: { set: secretSet, rm: secretRm, status: secretStatus },
  run: (ctx) => {
    if (dispatchedSubcommand(ctx) !== undefined) return Promise.resolve();
    return showUsage(ctx.cmd).then(() => {});
  },
});

// TEMP (do not merge): one-off completion through the configured LLM provider, for testing setup.
//   argus llm "say hello"   — uses the `llm` block from argus.json (provider/model/apiKeyEnv).
const llmCmd = defineCommand({
  meta: { name: "llm", description: "TEMP: run a one-off completion through the configured provider" },
  args: { text: { type: "positional", required: true, description: "prompt text (quote multi-word)" } },
  run: handler(async (args) => {
    const parts = Array.isArray(args._) ? (args._ as string[]) : [];
    const text = (parts.length ? parts.join(" ") : String(args.text ?? "")).trim();
    if (!text) throw new Error("Provide some prompt text, e.g. `argus llm \"say hello\"`.");
    const { llm } = resolveTaskExtraction();
    const apiKey = llm.apiKey ?? (await resolveApiKey(llm.apiKeyEnv));
    log(`provider=${llm.provider}${llm.model ? ` model=${llm.model}` : ""}${llm.apiKeyEnv ? ` key=${llm.apiKeyEnv}${apiKey ? "(set)" : "(missing)"}` : ""}`);
    const res = await complete({ prompt: text }, { ...llm, apiKey });
    if (!res.ok) {
      throw new Error(`LLM call failed${res.status != null ? ` (status ${res.status})` : ""}: ${res.error ?? "no output"}`);
    }
    process.stdout.write(res.text + "\n");
  }),
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
  subCommands: { serve, index, sync, run: runCmd, status, login, secret, llm: llmCmd /* TEMP */ },
});

async function run() {
  const argv = process.argv.slice(2);
  // `argus --version` / `argus -v`: print just the version and exit cleanly, with no banner. citty
  // would also answer this (meta.version is set), but only after the banner, which is noise for a
  // bare version query.
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    process.stdout.write(pkg.version + "\n");
    return;
  }
  // The `argus secret` commands are utilitarian (and `secret set` reads a key from stdin), so skip
  // the banner there — it's just noise.
  if (argv[0] !== "secret" && argv[0] !== "llm" /* TEMP */) printBanner();
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
