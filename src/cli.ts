#!/usr/bin/env bun
import { statSync } from "node:fs";
import { defineCommand, runMain, showUsage } from "citty";
import type { ArgsDef, CommandContext, ParsedArgs } from "citty";
import { printBanner } from "./banner.ts";
import { scanStore } from "./indexing/pipeline.ts";
import { STORE_FILE } from "./paths.ts";
import { ALL_SOURCES } from "./reporting/dashboard-builder.ts";
import { startServer } from "./api/serve.ts";
import { openStore } from "./store/store.ts";
import {
  runIndex,
  runIndexDelete,
  runIndexRebuild,
  runIndexRefresh,
} from "./index-ops.ts";
import { runSearch } from "./search-ops.ts";
import {
  pushSnapshotForOpts,
  watchIndex,
  watchSync,
  type PushLoopOptions,
} from "./watch.ts";
import { runRun } from "./run.ts";
import { hubErrorMessage } from "./push.ts";
import { CliUsageError, syncOptions, toSource } from "./cli-options.ts";
import {
  loadConfig,
  managedSettingValue,
  resolveReadOnly,
  resolveLogLevel,
  resolveSessionInterpretation,
  getPath,
  setPath,
  writeConfig,
  ALL_SETTINGS,
  type ResolvedSessionInterpretation,
} from "./config.ts";
import { defaultSecretStore, isSecretName, maskSecret, SECRET_NAMES } from "./secrets.ts";
import { logger as log, logError, type Log } from "./logger.ts";
import pkg from "../package.json" with { type: "json" };

const DEFAULT_PORT = Number(process.env.ARGUS_PORT) || 4242;
const DEFAULT_INDEX_INTERVAL_MIN = 1;
const DEFAULT_SYNC_INTERVAL_MIN = 5;

// The command-specific option shapes below layer each subcommand's own flags on top of the shared
// store-selection helpers used by extracted command bodies and long-running loops.
interface ServeOptions {
  port: number;
  open: boolean;
  readOnly: boolean;
}

function configureLog(args: Record<string, unknown> = {}): void {
  log.setLevel?.(resolveLogLevel(args, loadConfig()));
}

function printResultLine(message: string): void {
  process.stderr.write(message + "\n");
}

/** Parse a tri-state boolean override flag (e.g. `--extract-tasks`, `--retain-text`): unset → undefined
 *  (defer to argus.json/env), else the explicit boolean. Anything other than true/false is a usage
 *  error. One place so the accepted vocabulary and exit code don't drift across flags. */
function toBoolOverride(
  value: string | undefined,
  flagName: string,
): boolean | undefined {
  if (value == null) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  logError(log, `Invalid --${flagName}: ${value} (expected true or false)`);
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
async function guard(
  body: () => Promise<void>,
  args: Record<string, unknown> = {},
): Promise<void> {
  configureLog(args);
  try {
    await body();
  } catch (err) {
    logError(log, err instanceof Error ? err.message : String(err));
    process.exit(err instanceof CliUsageError ? err.exitCode : 1);
  }
}

// citty parses non-strictly (Node's util.parseArgs with strict:false): unknown flags are silently
// accepted, and a value-less string flag swallows the following token as its value. The hand-rolled
// parser this replaced rejected both, so we re-check the raw argv against each command's declared
// flags to keep typos and missing values failing loudly (#59).

const BUILTIN_FLAGS = new Set(["help", "h", "version", "v"]);

const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
const camel = (name: string): string =>
  name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** A flag name plus the camelCase/kebab-case spellings citty also accepts for it. */
const nameVariants = (name: string): string[] => [
  name,
  kebab(name),
  camel(name),
];

function failArg(message: string): never {
  logError(log, message);
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
    const aliases = Array.isArray(spec.alias)
      ? spec.alias
      : spec.alias
        ? [spec.alias]
        : [];
    for (const variant of [name, ...aliases].flatMap(nameVariants)) {
      allowed.add(variant);
      if (spec.type === "boolean") allowed.add(`no-${variant}`);
      if (spec.type === "string" || spec.type === "enum")
        stringFlags.add(variant);
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
    if (
      eq === -1 &&
      stringFlags.has(name) &&
      i + 1 < raw.length &&
      raw[i + 1] !== "--"
    )
      i++;
  }

  // A string flag whose parsed value is itself a flag means its value was omitted and the following
  // flag got swallowed (e.g. `report --since --out x` parses as since="--out"). Treat as missing.
  const parsed = ctx.args as Record<string, unknown>;
  for (const [name, spec] of Object.entries(def)) {
    if (spec.type !== "string" && spec.type !== "enum") continue;
    const value = parsed[name];
    if (
      typeof value === "string" &&
      value.length > 1 &&
      value.startsWith("-")
    ) {
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
    return guard(() => body(ctx.args), ctx.args as Record<string, unknown>);
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
    const aliases = Array.isArray(spec.alias)
      ? spec.alias
      : spec.alias
        ? [spec.alias]
        : [];
    for (const variant of [name, ...aliases].flatMap(nameVariants))
      valueFlags.add(variant);
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
      // The web app reads sessions from the paginated /api/sessions resource; the per-view dashboard
      // endpoints never build a per-session array.
      build: { source: "all", readOnly: true },
      // Per-session reindex (POST /api/sessions/:id/reindex) honors the argus.json task-extraction
      // setting (flag > env > argus.json > default), resolved here from config rather than a CLI flag.
      taskExtraction: taskExtractionOptions({}),
      readOnly: opts.readOnly,
    },
    log,
  );
}

/** One-shot upload of the current snapshot to Argus Hub (the bare `argus sync`). */
async function runPushOnce(opts: PushLoopOptions, log: Log): Promise<void> {
  const res = await pushSnapshotForOpts(opts, log);
  if (res.skipped) {
    log(res.body); // nothing was uploaded (e.g. a local-only source); not an error
  } else if (res.ok) {
    log(`Uploaded (${res.status}). ${res.body.slice(0, 200)}`);
  } else if (res.status === 422) {
    logError(log, `Hub rejected upload (422): ${hubErrorMessage(res.body)}`);
    process.exit(1);
  } else {
    logError(log, `Upload failed (${res.status}): ${res.body.slice(0, 400)}`);
    process.exit(1);
  }
}

async function runStatus(): Promise<void> {
  printResultLine(`Store path: ${STORE_FILE}`);
  try {
    printResultLine(`Store size: ${formatBytes(statSync(STORE_FILE).size)}`);
  } catch {
    printResultLine("Store size: unavailable");
  }
  let scans;
  try {
    scans = await scanStore({ sources: ALL_SOURCES });
  } catch (err) {
    printResultLine(
      `Couldn't read the local store: ${err instanceof Error ? err.message : String(err)}`,
    );
    printResultLine(
      "Run `argus index rebuild --force` to rebuild it from your transcripts.",
    );
    process.exit(1);
  }

  // Count every session the store actually holds, grouped by where it came from, so the per-source
  // lines and the total reconcile with what `argus index` reports (which counts the whole store).
  let counts: Array<{ owner: string; present: number; archived: number }> = [];
  let interpretation:
    | { interpreted: number; pending: number; outdated: number }
    | undefined;
  try {
    const store = await openStore();
    try {
      counts = await store.resolvedSessionCounts();
      interpretation = await store.interpretationProgress();
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
    const c = byOwner.get(scan.source) ?? {
      owner: scan.source,
      present: 0,
      archived: 0,
    };
    if (!scan.inUse && c.present + c.archived === 0) continue;
    total += c.present + c.archived;
    totalArchived += c.archived;
    if (!scan.upToDate) pending = true;
    const when = scan.lastSyncAtMs
      ? new Date(scan.lastSyncAtMs).toISOString()
      : "never";
    const state = scan.upToDate ? "up to date" : "pending changes";
    const archived = c.archived ? ` (+${c.archived} archived)` : "";
    lines.push(
      `  ${scan.source}: ${c.present} sessions${archived} · last synced ${when} · ${state}`,
    );
  }

  if (!lines.length) {
    printResultLine(
      "No sessions yet. Run `argus index` once you've used Claude Code, Claude Cowork, Codex, or Gemini.",
    );
    return;
  }
  for (const line of lines) printResultLine(line);
  if (lines.length > 1) printResultLine(`Total: ${total} sessions`);
  if (totalArchived) {
    printResultLine(
      `Kept after leaving disk: ${totalArchived} session${totalArchived === 1 ? "" : "s"} · remove with \`argus index delete --archived\``,
    );
  }
  // Interpretation backfill progress (#153): only meaningful once some sessions have been interpreted
  // or are waiting to be. Stay silent otherwise so a user who hasn't turned task extraction on sees nothing.
  if (
    interpretation &&
    (interpretation.interpreted > 0 || interpretation.pending > 0)
  ) {
    const outdated = interpretation.outdated
      ? `, ${interpretation.outdated} with new activity`
      : "";
    printResultLine(
      `Interpreted ${interpretation.interpreted} session${interpretation.interpreted === 1 ? "" : "s"} ` +
        `(${interpretation.pending} waiting${outdated}).`,
    );
  }
  if (pending)
    printResultLine("Run `argus index` to pick up new and changed sessions.");
}

// ---------------------------------------------------------------------------
// `argus config` helpers
// ---------------------------------------------------------------------------

/** Recursively flatten a config object into dotted key-value pairs. */
function flattenObject(obj: unknown, prefix = ""): [string, unknown][] {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return [];
  const result: [string, unknown][] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === "object" && !Array.isArray(value)) {
      result.push(...flattenObject(value, path));
    } else {
      result.push([path, value]);
    }
  }
  return result;
}

async function runConfigGet(key: string, json = false): Promise<void> {
  const value = getPath(loadConfig(), key);
  if (json) {
    process.stdout.write(JSON.stringify(value ?? null) + "\n");
    return;
  }
  if (value === undefined) {
    printResultLine("(not set)");
  } else {
    process.stdout.write(String(value) + "\n");
  }
}

async function runConfigSet(
  key: string,
  rawValue: string,
  log: Log,
): Promise<void> {
  const setting = ALL_SETTINGS[key];
  if (!setting) {
    throw new Error(
      `Unknown key: ${JSON.stringify(key)}\nKnown keys: ${Object.keys(ALL_SETTINGS).join(", ")}`,
    );
  }
  const parsed = setting.parse(rawValue);
  const cfg = loadConfig();
  setPath(cfg as Record<string, unknown>, key, parsed);
  writeConfig(cfg);
  log(`${key} = ${JSON.stringify(parsed)}`);
  // Printed unconditionally (not through the leveled logger): the save "worked" but won't take
  // effect, and a managed log.level may itself have quieted logger output below the point where a
  // warning would show.
  if (managedSettingValue(setting) !== undefined) {
    printResultLine(
      `Note: ${key} is managed by your organization, and the managed value takes precedence over the value just saved.`,
    );
  }
}

async function runConfigList(
  opts: { showSecrets?: boolean; asJson?: boolean },
): Promise<void> {
  const cfg = loadConfig();
  if (opts.asJson) {
    process.stdout.write(JSON.stringify(cfg, null, 2) + "\n");
    return;
  }
  const pairs = flattenObject(cfg);
  if (pairs.length === 0) {
    printResultLine("(no settings in argus.json)");
    return;
  }
  let hasRedacted = false;
  for (const [k, v] of pairs) {
    const isSecret = ALL_SETTINGS[k]?.secret === true;
    if (isSecret && !opts.showSecrets) {
      process.stdout.write(`${k}=<redacted>\n`);
      hasRedacted = true;
    } else {
      process.stdout.write(`${k}=${JSON.stringify(v)}\n`);
    }
  }
  if (hasRedacted) {
    printResultLine(
      "(use --show-secrets to reveal secret values, or --json for machine-readable output)",
    );
  }
}

// ---------------------------------------------------------------------------
// CLI definition (citty). Each subcommand declares its own flags; --help scopes
// to that subcommand automatically and flag types flow into the run handlers.
// ---------------------------------------------------------------------------

const filterArgs = {
  since: {
    type: "string",
    description: "Only include messages on/after this date",
    valueHint: "YYYY-MM-DD",
  },
  until: {
    type: "string",
    description: "Only include messages on/before this date",
    valueHint: "YYYY-MM-DD",
  },
  project: {
    type: "string",
    description: "Only include sessions whose directory contains this text",
    valueHint: "substr",
  },
} as const;

/** Source selection — shared by `run` and the `index` commands.
 *  Declared as a string (not enum) so citty's flag inference stays intact; the value set is
 *  validated by `toSource`. */
const sourceArg = {
  source: {
    type: "string",
    default: "all",
    description:
      "Transcript source: claude, codex, gemini, cowork, claude-chat, or all",
    valueHint: "claude|codex|gemini|cowork|claude-chat|all",
  },
} as const;

// Session-interpretation override flags (the deprecated per-consumer override layer over `llm.*`).
// These are the canonical `--interpret-*` spellings the settings registry advertises, each paired with
// its deprecated `--task-*` alias (both must be registered here or citty rejects the unknown flag; the
// resolver reads flag > legacyFlag). Flags carry no env-var defaults: an unset flag resolves to
// `undefined` so the config resolver can honor CLI flag > env > argus.json > default in one place (see
// resolveSessionInterpretation in config.ts).
const interpretOverrideArgs = {
  "interpret-provider": {
    type: "string",
    description:
      "Interpretation provider: claude, command, or off (env ARGUS_INTERPRET_PROVIDER)",
    valueHint: "claude|command|off",
  },
  "interpret-model": {
    type: "string",
    description:
      "Model for interpretation when the provider supports it (env ARGUS_INTERPRET_MODEL)",
    valueHint: "id",
  },
  "interpret-prompt": {
    type: "string",
    description: "Custom interpretation prompt (env ARGUS_INTERPRET_PROMPT)",
    valueHint: "text",
  },
  "interpret-prompt-file": {
    type: "string",
    description:
      "Read the interpretation prompt from a file (env ARGUS_INTERPRET_PROMPT_FILE)",
    valueHint: "path",
  },
  "interpret-command": {
    type: "string",
    description:
      "Command provider; reads prompt on stdin and writes JSON to stdout (env ARGUS_INTERPRET_COMMAND)",
    valueHint: "cmd",
  },
  // Deprecated aliases (kept working for one release; prefer the --interpret-* spellings above).
  "task-provider": { type: "string", description: "Deprecated alias for --interpret-provider.", valueHint: "claude|command|off" },
  "task-model": { type: "string", description: "Deprecated alias for --interpret-model.", valueHint: "id" },
  "task-prompt": { type: "string", description: "Deprecated alias for --interpret-prompt.", valueHint: "text" },
  "task-prompt-file": { type: "string", description: "Deprecated alias for --interpret-prompt-file.", valueHint: "path" },
  "task-command": { type: "string", description: "Deprecated alias for --interpret-command.", valueHint: "cmd" },
} as const;

/** The opt-in session-interpretation override shared by the indexing commands (index, rebuild,
 *  refresh). Tri-state: unset defers to argus.json; true/false overrides it for the run (see #93).
 *  `--extract-tasks` is the deprecated alias (#234), kept working for one release. */
const interpretArg = {
  interpret: {
    type: "string",
    description:
      "Interpret sessions this run: true|false (overrides argus.json). Omit to use the config setting.",
    valueHint: "true|false",
  },
  "extract-tasks": {
    type: "string",
    description: "Deprecated alias for --interpret.",
    valueHint: "true|false",
  },
} as const;

/** The effective interpret override for a run: `--interpret` wins, then the deprecated
 *  `--extract-tasks` alias. */
function interpretOverride(args: Record<string, unknown>): boolean | undefined {
  const raw = (args["interpret"] ?? args["extract-tasks"]) as string | undefined;
  return toBoolOverride(raw, "interpret");
}

/** The local text-retention override shared by the indexing commands (#120). Tri-state: unset defers
 *  to argus.json/env; true/false overrides it for the run. Stored text is local-only — never synced. */
const retainTextArg = {
  "retain-text": {
    type: "string",
    description:
      "Keep prompt/response text in the local store this run: true|false (local-only, never synced; overrides argus.json).",
    valueHint: "true|false",
  },
} as const;

const logArgs = {
  "log-level": {
    type: "string",
    description:
      "Log level: error, warn, info, debug, or trace (env ARGUS_LOG_LEVEL)",
    valueHint: "level",
  },
  quiet: {
    type: "boolean",
    default: false,
    description: "Only print warnings and errors",
  },
  verbose: { type: "boolean", default: false, description: "Print debug logs" },
} as const;

/** Include the task-extraction debug stream in the shared debug logs. */
const debugArg = {
  debug: {
    type: "boolean",
    default: false,
    description: "Print task-extraction debug logs",
  },
} as const;

/** Source/date/project selection flags shared by serve and sync. */
const buildArgs = {
  ...sourceArg,
  ...filterArgs,
} as const;

/** Resolve the effective task-extraction options for serve/run through the config chain (flag > env
 *  > argus.json > default). The `enabled` toggle is unused here — these commands extract on demand. */
function taskExtractionOptions(
  args: Record<string, unknown>,
): ResolvedSessionInterpretation {
  return resolveSessionInterpretation(args, loadConfig(), log);
}

const serve = defineCommand({
  meta: {
    name: "serve",
    description: "serve the interactive dashboard at a local web address",
  },
  args: {
    ...logArgs,
    port: {
      type: "string",
      alias: "p",
      default: String(DEFAULT_PORT),
      description: "Local port to listen on (env ARGUS_PORT)",
      valueHint: "N",
    },
    open: {
      type: "boolean",
      default: false,
      description: "Open the dashboard in your browser once it's ready (macOS)",
    },
    "read-only": {
      type: "boolean",
      description: "Read-only mode: hides editing and disables settings (env ARGUS_READ_ONLY; --no-read-only forces it off)",
    },
  },
  run: handler((args) =>
    runServe(
      {
        port: Number(args.port) || DEFAULT_PORT,
        open: args.open,
        readOnly: resolveReadOnly({ "read-only": args["read-only"] }, loadConfig()),
      },
      log,
    ),
  ),
});

// `argus index` — the local store maintenance group. The bare command does an incremental read;
// `--watch` keeps it running on an interval; the subcommands cover the destructive/scoped operations.
const indexRebuild = defineCommand({
  meta: {
    name: "rebuild",
    description:
      "rebuild the store from your transcripts (drops sessions no longer on disk)",
  },
  args: {
    ...sourceArg,
    ...interpretArg,
    ...retainTextArg,
    ...debugArg,
    ...logArgs,
    force: {
      type: "boolean",
      default: false,
      description: "Skip the confirmation prompt (for scripts/CI)",
    },
  },
  run: handler((args) =>
    runIndexRebuild(
      { ...syncOptions(args), force: args.force },
      log,
      interpretOverride(args),
      !!args.debug,
      toBoolOverride(args["retain-text"], "retain-text"),
    ),
  ),
});

const indexRefresh = defineCommand({
  meta: {
    name: "refresh",
    description:
      "re-read transcripts from disk; pass session id(s) to refresh only those",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description:
        "session id(s) to refresh (space-separated); omit to refresh all",
    },
    ...sourceArg,
    ...interpretArg,
    ...retainTextArg,
    ...debugArg,
    ...logArgs,
  },
  run: handler((args) =>
    runIndexRefresh(
      {
        ...syncOptions(args),
        ids: args._,
        extractTasks: interpretOverride(args),
        retainText: toBoolOverride(args["retain-text"], "retain-text"),
        debug: !!args.debug,
      },
      log,
    ),
  ),
});

const indexDelete = defineCommand({
  meta: {
    name: "delete",
    description: "permanently remove sessions from the local store",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "session id(s) to remove",
    },
    ...sourceArg,
    ...logArgs,
    archived: {
      type: "boolean",
      default: false,
      description:
        "Remove all sessions no longer on disk, optionally scoped by --source",
    },
  },
  run: handler((args) =>
    runIndexDelete(
      { source: toSource(args.source), archived: args.archived, ids: args._ },
      log,
    ),
  ),
});

const index = defineCommand({
  meta: {
    name: "index",
    description: "read new and changed sessions into the local store",
  },
  args: {
    ...sourceArg,
    ...interpretArg,
    ...retainTextArg,
    ...debugArg,
    ...logArgs,
    watch: {
      type: "boolean",
      default: false,
      description: "Keep reading new and changed sessions on an interval",
    },
    interval: {
      type: "string",
      default: String(DEFAULT_INDEX_INTERVAL_MIN),
      description: "Minutes between reads (with --watch)",
      valueHint: "N",
    },
  },
  subCommands: {
    rebuild: indexRebuild,
    refresh: indexRefresh,
    delete: indexDelete,
  },
  run: (ctx) => {
    // citty also runs this parent `run` after a subcommand handled the call — bail in that case.
    if (dispatchedSubcommand(ctx) !== undefined) return Promise.resolve();
    validateArgs(ctx);
    return guard(
      async () => {
        const args = ctx.args;
        const extractTasks = interpretOverride(args);
        const retainText = toBoolOverride(args["retain-text"], "retain-text");
        if (args.watch) {
          const ac = abortOnSignals();
          await watchIndex(
            {
              ...syncOptions(args),
              intervalMin: Number(args.interval) || DEFAULT_INDEX_INTERVAL_MIN,
              extractTasks,
              retainText,
            },
            log,
            ac.signal,
          );
        } else {
          await runIndex(
            syncOptions(args),
            log,
            extractTasks,
            !!args.debug,
            retainText,
          );
        }
      },
      ctx.args as Record<string, unknown>,
    );
  },
});

const status = defineCommand({
  meta: {
    name: "status",
    description: "show the local store path + per-source counts",
  },
  args: { ...logArgs },
  run: handler(() => runStatus()),
});

const search = defineCommand({
  meta: {
    name: "search",
    description:
      "search session titles, conversation text, task summaries, and touched files",
  },
  args: {
    query: {
      type: "positional",
      required: false,
      description: "free-text search over titles, conversation, and task text",
    },
    file: {
      type: "string",
      description: "only sessions that touched a file path containing this text",
      valueHint: "substr",
    },
    ...sourceArg,
    ...filterArgs,
    limit: {
      type: "string",
      default: "20",
      description: "maximum number of sessions to print",
      valueHint: "N",
    },
    json: {
      type: "boolean",
      default: false,
      description: "print matches as JSON (the same shape as /api/sessions rows)",
    },
    ...logArgs,
  },
  run: handler((args) =>
    runSearch(
      {
        source: toSource(args.source),
        query: args._[0],
        file: args.file,
        project: args.project,
        since: args.since,
        until: args.until,
        limit: Number(args.limit) || 20,
        json: !!args.json,
      },
      log,
    ),
  ),
});

const sync = defineCommand({
  meta: { name: "sync", description: "upload usage data to Argus Hub" },
  args: {
    ...logArgs,
    watch: { type: "boolean", default: false, description: "Keep uploading on an interval" },
    interval: { type: "string", default: String(DEFAULT_SYNC_INTERVAL_MIN), description: "Minutes between uploads (with --watch)", valueHint: "N" },
    all: { type: "boolean", default: false, description: "Re-upload every session, skipping local cursor filtering" },
  },
  run: handler(async (args) => {
    const base: PushLoopOptions = { source: "all", all: !!args.all };
    if (args.watch) {
      const ac = abortOnSignals();
      await watchSync({ ...base, intervalMin: Number(args.interval) || DEFAULT_SYNC_INTERVAL_MIN }, log, ac.signal);
    } else {
      await runPushOnce(base, log);
    }
  }),
});

const runCmd = defineCommand({
  meta: {
    name: "run",
    description:
      "keep the dashboard live: index, serve, and upload in one process",
  },
  args: {
    ...sourceArg,
    ...interpretOverrideArgs,
    ...logArgs,
    port: { type: "string", alias: "p", default: String(DEFAULT_PORT), description: "Local port to listen on (env ARGUS_PORT)", valueHint: "N" },
    "index-interval": { type: "string", default: String(DEFAULT_INDEX_INTERVAL_MIN), description: "Minutes between transcript reads", valueHint: "N" },
    "sync-interval": { type: "string", default: String(DEFAULT_SYNC_INTERVAL_MIN), description: "Minutes between uploads", valueHint: "N" },
    "no-sync": { type: "boolean", default: false, description: "Skip uploads (index and serve only)" },
    debug: { type: "boolean", default: false, description: "Print task extraction debug logs" },
  },
  run: handler((args) => {
    return runRun(
      {
        ...syncOptions(args),
        port: Number(args.port) || DEFAULT_PORT,
        indexIntervalMin: Number(args["index-interval"]) || DEFAULT_INDEX_INTERVAL_MIN,
        syncIntervalMin: Number(args["sync-interval"]) || DEFAULT_SYNC_INTERVAL_MIN,
        noSync: !!args["no-sync"],
        taskExtraction: taskExtractionOptions(args),
      },
      log,
    );
  }),
});

const configGet = defineCommand({
  meta: { name: "get", description: "print a setting from argus.json" },
  args: {
    key: {
      type: "positional",
      required: true,
      description: "dotted key, e.g. taskExtraction.enabled",
    },
    ...logArgs,
    json: {
      type: "boolean",
      default: false,
      description: "print the value as JSON (null when unset)",
    },
  },
  run: handler((args) => {
    if (args._.length !== 1) failArg("Usage: argus config get <key>");
    return runConfigGet(args._[0]!, args.json);
  }),
});

const configSet = defineCommand({
  meta: { name: "set", description: "write a setting to argus.json" },
  args: {
    key: {
      type: "positional",
      required: true,
      description: "dotted key and value, e.g. taskExtraction.enabled true",
    },
    ...logArgs,
  },
  run: handler((args) => {
    if (args._.length !== 2) failArg("Usage: argus config set <key> <value>");
    return runConfigSet(args._[0]!, args._[1]!, log);
  }),
});

const configList = defineCommand({
  meta: {
    name: "list",
    description: "list all settings currently in argus.json",
  },
  args: {
    "show-secrets": {
      type: "boolean",
      default: false,
      description: "Print secret values (e.g. hub.key) in plain text",
    },
    ...logArgs,
    json: {
      type: "boolean",
      default: false,
      description: "Output settings as JSON (unredacted; for programmatic use)",
    },
  },
  run: handler((args) =>
    runConfigList({ showSecrets: !!args["show-secrets"], asJson: !!args.json }),
  ),
});

const config = defineCommand({
  meta: {
    name: "config",
    description: "read and write settings in argus.json",
  },
  subCommands: { get: configGet, set: configSet, list: configList },
  run: async (ctx) => {
    if (dispatchedSubcommand(ctx) !== undefined) return;
    await showUsage(ctx.cmd);
  },
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
  const name = String(
    args.name ?? (Array.isArray(args._) ? args._[0] : "") ?? "",
  );
  if (!isSecretName(name)) {
    throw new Error(
      `Unknown secret "${name}". Known secrets: ${SECRET_NAMES.join(", ")}.`,
    );
  }
  return name;
}

const secretSet = defineCommand({
  meta: {
    name: "set",
    description: "store a secret (read from stdin, or prompted if interactive)",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "secret name (e.g. ANTHROPIC_API_KEY, ARGUS_HUB_KEY)",
    },
    ...logArgs,
  },
  run: handler(async (args) => {
    const name = requireSecretName(args);
    const value = await readSecretValue(name);
    if (!value.trim()) {
      // Empty input (pressed Enter / piped nothing) means skip — leave any existing value untouched.
      log(`Skipped ${name} — nothing entered.`);
      return;
    }
    await defaultSecretStore().set(name, value);
    // Mask the value in hand rather than reading it back (which would spawn a second keychain/DPAPI call).
    log(`Saved ${name} (${maskSecret(value)})`);
  }),
});

const secretRm = defineCommand({
  meta: { name: "rm", description: "remove a stored secret" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "secret name to remove",
    },
    ...logArgs,
  },
  run: handler(async (args) => {
    const name = requireSecretName(args);
    const removed = await defaultSecretStore().delete(name);
    log(removed ? `Removed ${name}.` : `${name} was not set.`);
  }),
});

const secretStatus = defineCommand({
  meta: {
    name: "status",
    description: "show which secrets are stored (masked)",
  },
  args: { ...logArgs },
  run: handler(async () => {
    const store = defaultSecretStore();
    for (const name of SECRET_NAMES) {
      const status = await store.describe(name);
      log(
        `  ${name}: ${status.configured ? (status.hint ?? "set") : "not set"}`,
      );
    }
  }),
});

const secret = defineCommand({
  meta: {
    name: "secret",
    description:
      "manage stored secrets — LLM API keys and the Argus Hub key (kept in your OS keychain where available)",
  },
  subCommands: { set: secretSet, rm: secretRm, status: secretStatus },
  run: (ctx) => {
    if (dispatchedSubcommand(ctx) !== undefined) return Promise.resolve();
    return showUsage(ctx.cmd).then(() => {});
  },
});

const main = defineCommand({
  meta: {
    name: "argus",
    version: pkg.version,
    description:
      "audit your Claude Code, Claude Cowork, Codex, and Gemini CLI usage",
  },
  // No root flags and no default command: every flag belongs to a specific subcommand, so running
  // `argus` with no subcommand falls through to the usage/help. Sessions stay in the local store
  // even after their transcripts age off disk; only `argus index delete` removes them.
  subCommands: { serve, index, sync, run: runCmd, status, search, config, secret },
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
  // The long-running orchestrator is the only command with enough startup surface for the banner.
  if (argv[0] === "run") printBanner();
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
  logError(log, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
