# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ This is a public repository

**Argus is public open source.** Never commit or push private, sensitive, or personal data —
not in code, tests, fixtures, comments, docs, or commit messages. This includes:

- **Secrets**: API keys, tokens, certificates, credentials, `.env` values.
- **Data stores**: `argus.db`, `argus.json`, the contents of `$ARGUS_CONFIG_DIR`/`$ARGUS_CACHE_DIR`,
  or any indexed/cached output produced by running Argus locally.
- **Agent session data**: real Claude/Codex/Gemini transcripts, prompts, or any captured
  conversation content from `~/.claude`, `~/.codex`, etc.
- **Local file information**: real home/user paths, machine names, directory listings, or anything
  that identifies a specific user or machine.
- **PII**: names, emails, org/customer identifiers, or any personal information.

When you need example data, synthesize it. Use redacted, obviously-fake fixtures (e.g. `/Users/you`,
`user@example.com`). When in doubt, leave it out and ask.

## What this is

Argus is a Bun + TypeScript CLI that audits local Claude Code, Codex, and Gemini usage. It reads
local session transcripts (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`, …) and
presents them two ways: an interactive local web app (`serve` — the preferred UI; see
`docs/web-app.md`), or a per-(org, user) snapshot uploaded to a private Cloudflare Worker backend
(`sync`, formerly `push`). `argus run` ties the long-running pieces together: it keeps the local
store current (`index --watch`), serves the web app, and uploads on a schedule (`sync --watch`) in
one supervised foreground process. Nothing is uploaded during `serve`/`index`; all parsing is local.

The Worker + D1 dashboard backend lives in a **separate private repo**, `agentdeploymentco/argus-dash`.
This repo is the public CLI only.

## Commands

```bash
bun run src/cli.ts serve --open          # run the interactive web app (needs build:web once)
bun run dev:web                           # Vite dev server for web/ (live reload; proxies /api → 4242)
bun test                                  # run all tests (uses bun:test, zero extra deps)
bun test test/parse.test.ts               # run a single test file
bun test -t "dedup"                       # run tests matching a name
bun run typecheck                         # tsc --noEmit for root src + web/ (also run in CI)
bun run build:web                         # build web/ → dist/web
bun run build:compile                     # compile a self-contained CLI binary → dist/argus (bun:sqlite, no Node)
bun run build:npm                         # build the publishable npm package set → dist/npm/* (all OS/arch)
bun run desktop:build                     # build the Tauri tray app → desktop/src-tauri/target/**/Argus.app
```

CI (`.github/workflows/ci.yml`) typechecks the root and `web/`, runs `bun test`, and verifies
`build:web` on every push/PR. Development runs `src/cli.ts`
directly with Bun. There is no Node-targeted bundle: the CLI compiles to a self-contained binary
with `bun build --compile` (it uses `bun:sqlite`, so it needs no Node/node-gyp). `bun run build:npm`
emits per-OS packages under `dist/npm/` — a launcher package (`@agentdeploymentco/argus`, the
published `bin`) plus `@agentdeploymentco/argus-<os>-<cpu>` prebuilt-binary packages it pulls in as
optional dependencies. The web app builds to `dist/web` and ships beside each binary. The desktop
tray app lives in `desktop/` (see `docs/`/issue #71) and bundles the compiled CLI as a sidecar.
The repo root `package.json` is `private` (a dev workspace); the published artifacts are generated
into `dist/npm/` and the desktop bundles, not the root package.

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

## User-facing UI

Rules for anything presented in the web app (and any other UI surface):

1. **Never present an unordered list.** Every list the user sees — `<select>` options, table rows,
   card grids, legends, any enumeration — must have an ordering that is obvious to the user. A list
   in arbitrary/source/insertion order is a bug.
2. **Pick the ordering that fits the context.** If there's a natural temporal order (newest/oldest)
   or numeric order (by tokens, cost, count, duration), use it — that's usually what the user wants
   to scan by, and make the sort direction unmistakable. **If there is no meaningful temporal or
   numeric ordering, sort alphabetically ascending.** (E.g. the LLM provider select has no inherent
   ranking, so it should be alpha — not registry/declaration order.)
3. **Sort the data, don't rely on how it arrived.** Order explicitly at the point of display (or in
   the query) so it can't drift when the underlying source reorders.

## Architecture

The pipeline is a one-way data flow. `src/` is laid out by stage (see `docs/architecture.md`):
**`src/indexing/`** (the pipeline: `pipeline.ts` coordinator, `discover.ts`, `producer.ts`,
`reconcile.ts`, `friction.ts`, `parse/producers/*`, `interpret/*`), **`src/store/`** (`store.ts`,
`store-contract.ts`, `session-store.ts`), **`src/reporting/`** (`aggregate.ts`,
`dashboard-builder.ts`, `inventory.ts`), and **`src/api/`**. Cross-cutting modules (`types.ts`,
`config.ts`, `paths.ts`, `pricing.ts`, `tool-categories.ts`, **`src/llm/`** [the shared LLM access
layer], **`secrets.ts`** [BYO API-key storage]) and the CLI/runtime layer (`cli.ts`,
`run.ts`, `watch.ts`, `index-ops.ts`, …) stay at `src/` root.

The data flow:

`indexing/` (Discover → Parse → Reconcile → Interpret → Materialize) → `store/` → `reporting/aggregate.ts` → (`api/serve.ts` web app | `push.ts` snapshot)

`reporting/dashboard-builder.ts` wraps read + `aggregate` as `buildDashboard()`, the single entry
point the `sync` command and the web server both call.

The HTTP API layer lives under **`src/api/`**: `serve.ts` (the Hono server + routes) plus the
serve-only modules that build its responses — `session-list.ts`, `recommendations.ts`,
`task-metrics.ts`, `debug-info.ts`. Nothing under `src/api/` is used by the `sync`/CLI pipeline.

- **`indexing/parse/producers/*`** — Per-source readers (claude/codex/gemini/cowork) that turn raw
  `.jsonl` transcripts into normalized facts. This is the most subtle layer; accuracy lives here:
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

- **`reporting/aggregate.ts`** — Pure transform from `ParseResult` → `Dashboard`. Builds all the breakdowns
  (daily, by model/source/skill/project, MCP servers, plugins, sessions). **Cost is computed by
  re-walking individual messages** (not by summing usage then pricing once) so sessions that mix
  models are priced correctly. Also derives per-session health (#38): friction counts, median/max
  turn duration, stop-reason mix, token-growth trend, and an ended-clean/interrupted/unknown
  outcome proxy — plus `frictionTotals` and per-project friction rollups (CLI-only fields).

- **`indexing/friction.ts`** — Session-level friction signals (#37): detection of interruptions,
  permission rejections, compactions, and turn durations from raw Claude JSONL records, plus
  the per-session fold. The claude producer emits `SessionFact.frictionEvents` that the pipeline
  (`indexing/reconcile.ts`) dedupes and folds. Events
  carry stable ids (record uuid / `tool_use_id`) so resumed-session replays don't double-count.
  Claude-only: codex/gemini sessions leave `SessionMeta.friction` undefined
  (unknown) rather than zero — the support matrix is documented in the module header.

- **`tool-categories.ts`** — Canonical tool/MCP parsing: `categorizeTool` (9 categories),
  `isMcpTool`, `parseMcpTool` (the `mcp__server__tool` split — requires ≥3 `__` segments,
  tool keeps any further `__`), and `toolDisplayName`. Both the producers and `reporting/aggregate.ts`
  use it so categorization and MCP server/tool naming remain consistent. `aggregate.ts`
  emits `byTool` (per-tool ranking) and `byToolCategory` (category rollup) from it.

- **`pricing.ts`** — USD/Mtok price table keyed by model *family* (substring match: opus/sonnet/haiku/gpt-5.x).
  Unknown models cost 0 and are tracked in `unpricedModels()`. Override prices via `$ARGUS_CONFIG_DIR/pricing.json`.

- **`src/llm/`** — The shared LLM access layer (#132; design in `docs/llm-providers.md`). `registry.ts`
  is the single source of truth: a list of `ProviderDescriptor`s (`providers/*` — `local.ts` =
  `claude-cli`/`command`; `claude-api`/`openai`/`gemini` = direct HTTP over `http.ts`, which owns
  429/5xx retry + a size cap; `openrouter` = a preset over the openai transport). `index.ts`'s
  `complete(request, config)` dispatches through the registry with
  **no per-provider branching**; `config.ts`'s apiKeyEnv default and `secrets.ts`'s allowlist derive
  from it too, so adding a provider is one descriptor + one registry entry. Never throws —
  `off`/no-key/network/bad-shape → `ok:false`. Pure of secret access (the consumer fills
  `config.apiKey`), so it's testable against an injected `fetch`. Task extraction is the first consumer.

- **`secrets.ts`** — BYO API-key storage: a `SecretStore` with platform backends (macOS keychain via
  `/usr/bin/security`, Windows DPAPI via PowerShell, Linux chmod-600 file), behind an injectable
  command-runner seam. `resolveApiKey` = `apiKeyEnv` env var → store → none. Local-only; never on the
  sync wire. Set via `argus secret` or the `serve` secret endpoints.

- **`reporting/inventory.ts`** — Reads `~/.claude/settings.json` (`enabledPlugins`) and `plugins/installed_plugins.json`
  to map skills (`plugin:skill`) to owning plugins and to surface **enabled-but-unused** plugins.

- **`indexing/interpret/summarize.ts`** — Per-session heuristic summary (`heuristicSummary`): a free one-liner built
  from the first prompt, top skills, top tools, and edited-file count. Fills `SessionRow.summary`
  for the web app's session-title fallback. (The old opt-in `claude -p` summarizer was removed in
  favor of #88's task interpretation.)

- **`api/serve.ts`** + **`web/`** — `argus serve`: a Hono server (`createApp` for routes, `startServer`
  to listen via `@hono/node-server`) serving the React+Vite SPA in `web/` from `dist/web` (SPA fallback
  to `index.html`) and exposing the JSON API:
  - `GET /api/snapshot` — the aggregate dashboard (`{ dashboard, recommendations, generatedAtMs }`),
    narrowed by `since`/`until`/`project`/`source` query params (mapped into `buildDashboard`'s
    filters; unknown source → 400). Built fresh per request — no server cache; concurrent identical
    builds share one in-flight promise and the client's React Query `staleTime` absorbs reloads.
    `includeSessions:false`, so the heavy per-session array is **not** in this payload.
  - `GET /api/sessions` — paginated/filtered/sorted session list (`api/session-list.ts` over
    `store.readSessionAggregates`, a SQL `GROUP BY` — no per-message JS walk).
  - `GET /api/session/:id` — one session's full `SessionRow`, built on demand from its messages.
  - `POST /api/sessions/:id/reindex`, `GET /api/sessions/:id/task-metrics`, `GET /api/debug`.

  The frontend stack (React, Vite, TanStack Router/Query/Table, Chart.js via react-chartjs-2) is
  **devDependencies only** — bundled into `dist/web` at build, never installed by end users; only
  `hono`+`@hono/node-server` are runtime deps. `web/src/types.ts` imports the CLI `Dashboard` types
  **type-only** from `src/` (incl. `src/api/`), so the API payload and UI can't drift. The preferred
  UI; full design + rationale in **`docs/web-app.md`**. `serve` takes only `--port`/`-p` and `--open`
  (the date/source filters are per-request query params, not CLI flags) and resolves per-session-reindex
  task extraction from `argus.json`. New `/api/sessions`+`/api/session/:id` response shapes are
  local-only (not on the `@agentdeploymentco/argus-schema` sync wire).

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

- **`indexing/interpret/` (`index.ts`, `task-extraction.ts`, `task-candidates.ts`, `dialogue.ts`, `summarize.ts`)** —
  The Interpret stage: the one model-driven, opt-in step (#88/#91; full design in
  `docs/task-interpretation.md`). `interpret/index.ts` is the stage entry (`extractTasksForSessions`,
  `taskExtractionActive`) the pipeline calls. `task-candidates.ts`
  filters user-authored text into `TaskCandidateFact`s and recognizes Argus's own `claude -p` prompts
  so they aren't mistaken for user tasks. `task-extraction.ts` runs the two passes — pass 1 segments
  tasks/chapters, pass 2 judges per-task outcome/frustration from the prompt/response dialogue
  projected straight from the reconciled interactions — via the shared LLM layer (`src/llm/`),
  defaulting to the `claude-cli` provider (`claude -p --no-session-persistence --model haiku -`). The
  per-interaction prompt/response text is kept **out of the stored interaction records** but is
  retained separately, **opt-in (default-on) and local-only**, in `resolved_interaction_text` (#120;
  `retainText` setting) — a tall, typed table (`type` = prompt/response, narration-ready) shaped like
  `resolved_usage`/`resolved_invocations` (own `seq` + soft-link `interaction_seq`), never on the sync wire.

- **`cli.ts`** — The executable entry point (npm `bin`). Defines the subcommands (`serve`,
  `index` [+ `rebuild`/`refresh`/`delete` subcommands and `--watch`], `sync` [the upload, formerly
  `push`; + `--watch`], `run`, `status`, `login`) with [citty](https://github.com/unjs/citty): each
  declares its own flags, `--help` scopes per subcommand, and flag types flow into the handlers. There
  is no default command: a bare `argus` (no subcommand) prints the usage/help. `serve` exposes only
  `--port`/`-p` and `--open`. `index refresh` takes space-separated session ids (per-session reindex,
  matching `index delete`); `--extract-tasks <true|false>` on `index`/`rebuild`/`refresh` overrides the
  `argus.json` task-interpretation setting for the run. Holds the `run*` handlers that wire flags into
  `reporting/dashboard-builder.ts` and the pipeline. Note: citty runs a parent command's `run` *even
  after* dispatching to a subcommand, so `index`'s parent `run` bails via `dispatchedSubcommand(ctx)`
  when a subcommand handled the call. The store-maintenance bodies live in `index-ops.ts`; the
  long-running `--watch` loops and the orchestrator are in `watch.ts` / `run.ts` (see below).

- **`index-ops.ts`** — The `argus index` command bodies (`runIndex`, `runIndexRebuild` with its
  confirmation prompt, `runIndexRefresh`, `runIndexDelete`), extracted so both `cli.ts` and the watch
  loop share them. The only writers to the store. `runIndexRefresh` takes optional session ids: bare =
  full re-read; with ids = per-session reindex via `reindexSession` (in `indexing/pipeline.ts`). All
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
frustration) live in `store/store-contract.ts` and are **local-only** — they are not pushed by `sync`,
so adding/changing them needs no schema-package bump. `store/store-contract.ts` (the parse→store fact
contract, including `PARSED_FRAGMENT_CONTRACT_VERSION`) is separate from the
`@agentdeploymentco/argus-schema` wire contract.
