# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Argus is a Bun + TypeScript CLI that audits local Claude Code, Codex, and Gemini usage. It reads
local session transcripts (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`, …) and
presents them three ways: a self-contained HTML dashboard (`report`), an interactive local web app
(`serve` — the preferred UI; see `docs/web-app.md`), or a per-(org, user) snapshot uploaded to a
private Cloudflare Worker backend (`sync`, formerly `push`). `argus run` ties the long-running pieces
together: it keeps the local store current (`index --watch`), serves the web app, and uploads on a
schedule (`sync --watch`) in one supervised foreground process. Nothing is uploaded during
`report`/`serve`/`index`; all parsing is local.

The Worker + D1 dashboard backend lives in a **separate private repo**, `agentdeploymentco/argus-dash`.
This repo is the public CLI only.

## Commands

```bash
bun run src/cli.ts [report] [--open]     # build the dashboard (entry point)
bun run src/cli.ts serve --open          # run the interactive web app (needs build:web once)
bun run dev:web                           # Vite dev server for web/ (live reload; proxies /api → 4242)
bun test                                  # run all tests (uses bun:test, zero extra deps)
bun test test/parse.test.ts               # run a single test file
bun test -t "dedup"                       # run tests matching a name
bun run typecheck                         # tsc --noEmit for root src + web/ (also run in CI)
bun run build:web                         # build web/ → dist/web
bun run build                             # build the Node CLI (runs build:web first)
```

CI (`.github/workflows/ci.yml`) typechecks the root and `web/`, runs `bun test`, and verifies
`build:web` on every push/PR. Development runs `src/cli.ts` directly with Bun. The published npm
`bin` is `dist/cli.js`, a Node-targeted bundle built with `bun run build`; the web app is built to
`dist/web` and ships in the same package.

## User-facing messages

Anything printed to the terminal (CLI `log()`/`console` output, help text, error messages) is
written for a moderately technical user who understands the language of agents and computers generally, not for someone who has read the code:

1. **Plain language.** Use words a user already knows — file, directory, session, transcript,
   project. Avoid internal jargon.
2. **Don't name code internals.** The user doesn't know what the code does, so don't refer to
   implementation concepts (table names, "the structural index", "fragments", "materialize",
   "reconcile", "fact rows", layer numbers, etc.). Describe the effect the user observes instead
   (e.g. "Re-reading all transcripts from disk", not "Cleared the structural index").
3. **Active voice** where possible ("Kept archived sessions", not "archived sessions were preserved").
4. **Don't make Argus the subject.** Drop the actor and lead with the verb — "Kept archived
   sessions.", not "Argus kept archived sessions."

These rules are for output the user sees. Code comments and internal identifiers stay precise and
may use the internal vocabulary freely.

**Product name styling.** Anthropic styles it **Claude Cowork** — "Cowork" with a lowercase "w"
(not "CoWork" or "Co-Work"). Use this exact casing in all user-facing strings. The internal
source identifier / slug stays `cowork` (all lowercase).

## Architecture

The pipeline is a one-way data flow; each stage is its own module:

`parse.ts` → `aggregate.ts` → (`report.ts` HTML | `serve.ts` web app | `push.ts` snapshot)

`dashboard-builder.ts` wraps `parse → aggregate` as `buildDashboard()`, the single entry point the
`report`/`sync` commands and the web server all call.

- **`parse.ts`** — Reads raw `.jsonl` transcripts into `MessageRecord[]` + session metadata.
  This is the most subtle file; accuracy lives here:
  - Walks directories **recursively** so subagent transcripts (`<session>/subagents/*.jsonl`) are included.
  - **Dedupes** assistant messages by API `message.id` (first occurrence wins) because resumed/compacted
    sessions re-append earlier messages verbatim — same approach as `ccusage`.
  - Claude and Codex have **different transcript shapes** and are parsed by separate branches. Claude
    usage comes from `assistant` messages with `message.usage`; Codex usage comes from `event_msg`
    `token_count` events, with tool calls accumulated as `pendingToolUses` and flushed per token-count event.
  - Cache accounting: Anthropic splits cache writes into 5m/1h ephemeral buckets; Codex `cached_input_tokens`
    is treated as cache **read** (it's a subset of total input).
  - Tool *results* (output dumped back into context) are attributed to the producing tool via the
    `tool_use_id`/`call_id` → tool-name maps, for the "heaviest tool results" view.

- **`aggregate.ts`** — Pure transform from `ParseResult` → `Dashboard`. Builds all the breakdowns
  (daily, by model/source/skill/project, MCP servers, plugins, sessions). **Cost is computed by
  re-walking individual messages** (not by summing usage then pricing once) so sessions that mix
  models are priced correctly. Also derives per-session health (#38): friction counts, median/max
  turn duration, stop-reason mix, token-growth trend, and an ended-clean/interrupted/unknown
  outcome proxy — plus `frictionTotals` and per-project friction rollups (CLI-only fields).

- **`friction.ts`** — Session-level friction signals (#37): detection of interruptions,
  permission rejections, compactions, and turn durations from raw Claude JSONL records, plus
  the per-session fold. Shared by both parse paths (`parse.ts` directly; `parse-claude.ts`
  emits `SessionFact.frictionEvents` that `parse-incremental.ts` dedupes and folds). Events
  carry stable ids (record uuid / `tool_use_id`) so resumed-session replays don't double-count.
  Claude-only: codex/gemini/AgentsView sessions leave `SessionMeta.friction` undefined
  (unknown) rather than zero — the support matrix is documented in the module header.

- **`tool-categories.ts`** — Canonical tool/MCP parsing: `categorizeTool` (9 categories),
  `isMcpTool`, `parseMcpTool` (the `mcp__server__tool` split — requires ≥3 `__` segments,
  tool keeps any further `__`), and `toolDisplayName`. Both `parse.ts` and `aggregate.ts`
  use it so categorization and MCP server/tool naming remain consistent. `aggregate.ts`
  emits `byTool` (per-tool ranking) and `byToolCategory` (category rollup) from it.

- **`pricing.ts`** — USD/Mtok price table keyed by model *family* (substring match: opus/sonnet/haiku/gpt-5.x).
  Unknown models cost 0 and are tracked in `unpricedModels()`. Override prices via `$ARGUS_CONFIG_DIR/pricing.json`.

- **`inventory.ts`** — Reads `~/.claude/settings.json` (`enabledPlugins`) and `plugins/installed_plugins.json`
  to map skills (`plugin:skill`) to owning plugins and to surface **enabled-but-unused** plugins.

- **`summarize.ts`** — Per-session summaries. Default is a free heuristic; `--summarize` shells out to
  headless `claude -p` and caches results in `$ARGUS_CACHE_DIR/summaries.json`, keyed by session + last-activity
  timestamp (so re-runs are incremental).

- **`report.ts`** / **`chartjs.ts`** — Render the `Dashboard` to one self-contained HTML file with Chart.js
  inlined from `src/vendor/` (works fully offline). `report.ts` also supports a team/Worker mode (user
  selector) — that path is exercised by `argus-dash`, not the CLI. Untouched by the web app.

- **`serve.ts`** + **`web/`** — `argus serve`: a Hono server (`createApp` for routes, `startServer` to
  listen via `@hono/node-server`) exposing `GET /api/snapshot` (`{ dashboard, recommendations,
  generatedAtMs }`, cached 30s in-memory, `?refresh` forces a re-read) and serving the React+Vite SPA
  in `web/` from `dist/web` (SPA fallback to `index.html`). The frontend stack (React, Vite, TanStack
  Router/Query/Table, Chart.js via react-chartjs-2) is **devDependencies only** — bundled into
  `dist/web` at build, never installed by end users; only `hono`+`@hono/node-server` are runtime deps.
  `web/src/types.ts` imports the CLI `Dashboard` types **type-only** from `src/`, so the API payload and
  UI can't drift. The preferred UI; full design + rationale in **`docs/web-app.md`**. Note: `serve`
  reads the warm store incrementally like `report` (not a cold re-parse) — the `log("Reading
  transcripts…")` line is inherited from `report` and is a candidate to reword for the warm-store case.

- **`push.ts`** — The upload mechanics behind `argus sync` (the command was renamed from `push`; the
  module keeps its name). Detects user (git email → `$USER@host`) and org (email domain), POSTs the
  snapshot to `<endpoint>/ingest` with a bearer token. The server is authoritative on org/token
  validation.

- **`paths.ts`** — All filesystem locations, honoring `CLAUDE_CONFIG_DIR`, `CODEX_HOME`/`CODEX_CONFIG_DIR`.
  `CONFIG_FILE` = `$ARGUS_CONFIG_DIR/argus.json` (the settings store; see `config.ts`).

- **`config.ts`** — The `argus.json` settings store (the config peer of `argus.db`; full design in
  `docs/configuration.md`). Tolerant loader (missing → defaults; malformed/bad value → warn + default,
  never crash) plus a **settings registry + resolver**: each setting binds its kebab/SCREAMING_SNAKE/
  camelCase names + `parse()` in one descriptor, and `resolveSetting` walks `flag > env > argus.json >
  default` (empty values count as absent). `resolveTaskExtraction` produces the effective
  `TaskExtractionOptions` + `enabled` toggle. Settings only — `token.json`/`pricing.json` stay separate.

- **`task-extraction.ts` / `task-candidates.ts` / `session-tasks.ts` / `dialogue.ts`** — The task
  *interpretation* layer (#88/#91; full design in `docs/task-interpretation.md`). `task-candidates.ts`
  filters user-authored text into `TaskCandidateFact`s and recognizes Argus's own `claude -p` prompts
  so they aren't mistaken for user tasks. `task-extraction.ts` runs the two passes — pass 1 segments
  tasks/chapters, pass 2 judges per-task outcome/frustration from the reconstructed dialogue — via the
  `off`/`claude`/`command` providers (the claude provider runs `claude -p --no-session-persistence
  --model haiku -`). `dialogue.ts` holds the format-agnostic `DialogueTurn` + time-slicing; the
  per-source reconstruction lives in each producer's parser (`NativeProducer.reconstructDialogue`) and
  is an in-memory intermediate — **no message text is stored**. `session-tasks.ts` is the legacy
  on-demand web extraction path (retired by #92).

- **`cli.ts`** — The executable entry point (npm `bin`). Defines the subcommands (`report`, `serve`,
  `index` [+ `rebuild`/`refresh`/`delete` subcommands and `--watch`], `sync` [the upload, formerly
  `push`; + `--watch`], `run`, `status`, `login`) with [citty](https://github.com/unjs/citty): each
  declares its own flags, `--help` scopes per subcommand, and flag types flow into the handlers. There
  is no default command: a bare `argus` (no subcommand) prints the usage/help. The terminal overview
  is `argus report --console`. `index refresh` takes space-separated session ids (per-session reindex,
  matching `index delete`); `--extract-tasks <true|false>` on `index`/`rebuild`/`refresh` overrides the
  `argus.json` task-interpretation setting for the run. Holds the `run*` handlers that wire flags into `dashboard-builder.ts`
  and the pipeline. Note: citty runs a parent command's `run` *even after* dispatching to a
  subcommand, so `index`'s parent `run` bails via `dispatchedSubcommand(ctx)` when a subcommand
  handled the call. The store-maintenance bodies live in `index-ops.ts`; the long-running `--watch`
  loops and the orchestrator are in `watch.ts` / `run.ts` (see below).

- **`index-ops.ts`** — The `argus index` command bodies (`runIndex`, `runIndexRebuild` with its
  confirmation prompt, `runIndexRefresh`, `runIndexDelete`), extracted so both `cli.ts` and the watch
  loop share them. The only writers to the store. `runIndexRefresh` takes optional session ids: bare =
  full re-read; with ids = per-session reindex via `reindexSession` (in `parse-incremental.ts`). All
  three resolve task interpretation through `config.ts`, with an optional `--extract-tasks` override.

- **`backoff.ts`** — Shared loop primitives for the long-running commands: cancellable `sleep`, a
  jittered/capped `Backoff`, a `RepeatCollapser` (collapses repeated identical failure logs), and
  `superviseLoop` (restarts a crashing leg with backoff, exits on `AbortSignal`).

- **`watch.ts`** — `watchIndex` and `watchSync` (the `--watch` loops, factored so `run` calls them
  in-process). `watchSync` takes `onUnauthenticated: "fail" | "dormant"` — standalone fails fast,
  the `run`-embedded leg stays dormant and recovers after `argus login`. Both accept optional test
  seams. `resolveCredentials`/`pushSnapshotForOpts` (the push mechanics) live here too.

- **`run.ts`** — `argus run`: one foreground process, one `AbortController` + single SIGINT/SIGTERM
  handler, `Promise.all` of `watchIndex` + a supervised `serve` + `watchSync` against one shared
  store. `assertHomeResolved` is the fatal-startup guard for the service-manager minimal-env case.

## The wire contract (important)

Stable types come from the external package `@agentdeploymentco/argus-schema` (pinned to a git tag in
`package.json`). `types.ts` re-exports them and extends `Dashboard`/`SessionRow` with CLI-only fields
(e.g. `bySource`, `source`). The schema package is the single source of truth shared with `argus-dash`.

`test/contract.test.ts` builds a dashboard from fixtures and validates it against the schema's
`PushPayloadSchema`, so any drift between the CLI's output and the wire contract **fails CI**. When
changing the `Dashboard` shape, update the schema package and bump its pinned version here in lockstep.

Not everything is on the wire: `TaskFact` and the task-interpretation fields (chapter span, outcome,
frustration) live in `store-contract.ts` and are **local-only** — they are not pushed by `sync`, so
adding/changing them needs no schema-package bump. `store-contract.ts` (the parse→store fact contract,
including `PARSED_FRAGMENT_CONTRACT_VERSION`) is separate from the `@agentdeploymentco/argus-schema`
wire contract.
