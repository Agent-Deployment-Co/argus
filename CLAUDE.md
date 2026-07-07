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

**Who it's for.** Argus is built for **business users, not developers** — and explicitly not for
developer workflows. That audience is a range: at one end, any knowledge worker using agents like
Claude Cowork or Codex for business work (account research, drafting and editing content, working
in spreadsheets, building workflows); at the other, more technical non-developers who live in a
terminal, run Claude Code, and write the occasional script (technical RevOps, GTM engineers). What
unites them is that they use agents to do their *business* work, not to build software. When you
design features, write copy, or choose examples/taxonomies, assume this range and never assume a
developer. (See the `docs/index.md` positioning and the `docs/contributing/` voice guides; don't
call them "non-coders" or talk down.)

Argus audits local agent usage — Claude Code, Claude Cowork, Claude Chat, Codex, and Gemini — by
reading local session transcripts (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`,
…). All parsing is local. **Most users run the desktop app**, and it's the preferred way to interact
with Argus: a Tauri **tray app** (`desktop/`) that wraps the CLI — it bundles the compiled `argus`
binary plus the web assets, supervises `argus run` in the background, opens the dashboard in the
user's default browser through a stable local front-door port (default `4242`, proxied so an open
tab survives background restarts), and auto-updates. The tray app is the front door; the CLI is the
engine underneath.

That engine is a Bun + TypeScript CLI, and the more technical end of the audience can run it
directly. `serve` runs the local **web app** — a React SPA (see `docs/internals/web-app.md`) that is
the dashboard the desktop app opens. `index` reads transcripts into the local store (`argus.db`).
`sync` (formerly `push`) uploads per-(org, user) usage data to a private Cloudflare Worker backend.
`run` ties the long-running pieces together (`index --watch` + `serve`, plus `sync --watch` when a
Hub is configured) in one supervised process — this is what the desktop app runs. Nothing is
uploaded during `serve`/`index`; the only data that ever leaves the machine is what `sync` sends.

This repo is the public CLI, its web app (`web/`), and the desktop tray shell (`desktop/`). The
Worker + D1 backend that `sync` uploads to lives in a **separate public repo**,
`agentdeploymentco/argus-hub`.

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
`build:web` on every PR and on pushes to `main`. Development runs `src/cli.ts`
directly with Bun. There is no Node-targeted bundle: the CLI compiles to a self-contained binary
with `bun build --compile` (it uses `bun:sqlite`, so it needs no Node/node-gyp). `bun run build:npm`
emits per-OS packages under `dist/npm/` — a launcher package (`@agentdeploymentco/argus`, the
published `bin`) plus `@agentdeploymentco/argus-<os>-<cpu>` prebuilt-binary packages it pulls in as
optional dependencies. The web app builds to `dist/web` and ships beside each binary. The desktop
tray app lives in `desktop/` and bundles the compiled CLI as a sidecar.
The repo root `package.json` is `private` (a dev workspace); the published artifacts are generated
into `dist/npm/` and the desktop bundles, not the root package.

## User-facing messages

Anything printed to the terminal (CLI `log()`/`console` output, help text, error messages) is
written for the person running the CLI — the more technical end of the audience above (comfortable
in a terminal and fluent in the language of agents), but still not someone who has read the code:

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

## Writing the docs

When writing or editing anything under `docs/` (the VitePress site), follow the authoring
guides in **`docs/contributing/`**: `voice-and-tone.md` (how the docs should sound) and
`technical-writing.md` (structure, formatting, terminology). They specialize ADC's house voice
for Argus's technical docs and extend the "User-facing messages" rules above. Note in
particular: no em-dashes, and don't surface code internals on user-facing pages. The
`docs/contributing/` guides (and the `docs/internals/` design docs) are excluded from the published
site (`srcExclude`).

## Architecture

The pipeline is a one-way data flow, and `src/` is laid out by stage (full map in
`docs/internals/architecture.md`): **`src/indexing/`** (the pipeline — discover, parse, reconcile,
materialize, plus the interpret drain), **`src/store/`** (the `argus.db` layer + its parse→store
contract), **`src/reporting/`** (per-session and plugin aggregation), and **`src/api/`** (the serve
layer). Cross-cutting modules (`types.ts`, `config.ts`, `paths.ts`, `pricing.ts`, `tool-categories.ts`,
**`src/llm/`** [the shared LLM access layer], **`secrets.ts`** [BYO API-key storage]) and the
CLI/runtime layer (`cli.ts`, `run.ts`, `watch.ts`, `index-ops.ts`) stay at `src/` root.

The data flow:

`indexing/` (Discover → Parse → Reconcile → Materialize; Interpret runs afterwards as a decoupled, throttled drain — model-driven, default-on but toggleable) → `store/` → (`api/serve.ts` per-view endpoints for the web app | `push.ts` raw-row upload for `sync`)

Neither read path assembles a monolithic `Dashboard`: `serve` answers one small endpoint per view,
each reading only what it needs straight off `argus.db`, and `sync` uploads raw `resolved_*`
rows that the Hub aggregates server-side. `reporting/dashboard-builder.ts` is now just the shared
source-selection helpers.

The HTTP API layer lives under **`src/api/`**: `serve.ts` (the Hono server + routes) plus the
serve-only modules that build its responses. The indexing pipeline and `push.ts` don't import
anything under `src/api/` (only `cli.ts`/`run.ts` do, to start the server).

- **`indexing/parse/producers/*`** — Per-source readers (claude/codex/gemini/cowork) that turn raw
  `.jsonl` transcripts into normalized facts. This is the most subtle layer; accuracy lives here:
  - Walks directories **recursively** so subagent transcripts (`<session>/subagents/*.jsonl`) are included.
  - **Dedupes** assistant messages by API `message.id` (first occurrence wins) because resumed/compacted
    sessions re-append earlier messages verbatim — same approach as `ccusage`.
  - Claude and Codex have **different transcript shapes** and are parsed by separate branches. Claude
    usage comes from `assistant` messages with `message.usage`; Codex usage comes from `event_msg`
    `token_count` events, with tool calls accumulated per turn and flushed on each token-count event.
  - Cache accounting: Anthropic splits cache writes into 5m/1h ephemeral buckets; Codex `cached_input_tokens`
    is treated as cache **read** (it's a subset of total input).
  - Tool *results* (output dumped back into context) are attributed to the producing tool via the
    `tool_use_id`/`call_id` → tool-name maps, for the "heaviest tool results" view.

- **`reporting/aggregate.ts`** — Per-session row assembly + plugin folding (the monolithic dashboard
  `aggregate()` is gone). `buildSessionRow` turns one session's messages + metadata into a
  `SessionRow` — including per-session health: friction counts, median/max turn duration,
  stop-reason mix, token-growth trend — and is shared by the on-demand `/api/session/:id` detail and
  the paginated `/api/sessions` list. `foldPlugins` folds per-skill + per-MCP-server usage into
  per-plugin rows (used by the `/api/plugins` builder). Cost is priced per message here (via `cost()`);
  the per-view builders price per `(dimension, model)` row from the store's SQL sums.

- **`indexing/friction.ts`** — Session-level friction signals: detection of interruptions,
  permission rejections, compactions, and turn durations from raw Claude JSONL records, plus
  the per-session fold. The claude producer emits `SessionFact.frictionEvents` that the pipeline
  (`indexing/reconcile.ts`) dedupes and folds. Events
  carry stable ids (record uuid / `tool_use_id`) so resumed-session replays don't double-count.
  Claude-only: codex/gemini sessions leave `SessionMeta.friction` undefined
  (unknown) rather than zero — the support matrix is documented in the module header.

- **`tool-categories.ts`** — Canonical tool/MCP parsing: `categorizeTool` (9 categories),
  `isMcpTool`, `parseMcpTool` (the `mcp__server__tool` split — requires ≥3 `__` segments,
  tool keeps any further `__`), and `toolDisplayName`. The producers and the reporting/serve layers
  all route through it so categorization and MCP server/tool naming stay consistent. `api/tools.ts`
  builds `byTool` (per-tool ranking) and `byToolCategory` (category rollup) from the store's tool stats.

- **`pricing.ts`** — USD/Mtok price table keyed by model *family* (substring match: opus/sonnet/haiku/gpt-5.x).
  Unknown models cost 0 and are tracked in `unpricedModels()`. Override prices via `$ARGUS_CONFIG_DIR/pricing.json`.

- **`src/llm/`** — The shared LLM access layer (design in `docs/internals/llm-providers.md`).
  `registry.ts` is the single source of truth: a list of `ProviderDescriptor`s (local CLI/command
  providers plus direct-HTTP API providers). `complete(request, config)` dispatches through the
  registry with **no per-provider branching**, and `config.ts`'s key-env defaults and `secrets.ts`'s
  allowlist derive from it too, so adding a provider is one descriptor + one registry entry. Never
  throws — off/no-key/network/bad-shape → `ok:false`. Pure of secret access (the consumer fills
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
  favor of task interpretation.)

- **`api/serve.ts`** + **`web/`** — `argus serve`: a Hono server (`createApp` for routes, `startServer`
  to listen) serving the React+Vite SPA in `web/` from `dist/web` (SPA fallback to `index.html`) and
  exposing the JSON API. There is **no monolithic `/api/snapshot`**: each dashboard view has its own
  small endpoint, built on demand with no server-side cache (the client's React Query `staleTime`
  absorbs reloads). The view endpoints (usage, tools, skills, plugins, health, recommendations, the
  session list, per-session detail, …; see `serve.ts` for the live route list) share one
  `since`/`until`/`project`/`source` filter contract (unknown source → 400). Each view is a promoted
  store read plus a small pure builder in `api/` that folds + prices it; the session list is a SQL
  `GROUP BY` (no per-message JS walk) and per-session detail is built on demand from that session's
  messages.

  The frontend stack (React, Vite, TanStack Router/Query/Table, Chart.js) is **devDependencies
  only** — bundled into `dist/web` at build, never installed by end users; the web server's only
  runtime deps are `hono`+`@hono/node-server`. `web/src/types.ts` imports the CLI response types
  **type-only** from `src/` (incl. `src/api/`), so the API payload and UI can't drift. The preferred
  UI; full design in **`docs/internals/web-app.md`**. `serve` takes only `--port`/`-p` and `--open`
  (date/source filters are per-request query params, not CLI flags).

- **`push.ts`** — The upload mechanics behind `argus sync` (the command was renamed from `push`; the
  module keeps its name). Identifies the client by a per-install id plus a git `user.name`
  fingerprint (the Hub attributes it to a user/org server-side) and POSTs raw `resolved_*` rows to
  the Hub's `/api/sync` endpoint with a bearer token. The server is authoritative on org/token
  validation.

- **`paths.ts`** — All filesystem locations, honoring `CLAUDE_CONFIG_DIR`, `CODEX_HOME`/`CODEX_CONFIG_DIR`.
  `CONFIG_FILE` = `$ARGUS_CONFIG_DIR/argus.json` (the settings store; see `config.ts`).

- **`config.ts`** — The `argus.json` settings store (the config peer of `argus.db`; full design in
  `docs/internals/configuration.md`). Tolerant loader (missing → defaults; malformed/bad value → warn + default,
  never crash) plus a **settings registry + resolver**: each setting binds its kebab/SCREAMING_SNAKE/
  camelCase names + `parse()` in one descriptor, and `resolveSetting` walks `flag > env > argus.json >
  default` (empty values count as absent). `resolveTaskExtraction` produces the effective
  `TaskExtractionOptions` + `enabled` toggle. Settings only — `token.json`/`pricing.json` stay separate.

- **`indexing/interpret/`** — The Interpret stage: the one model-driven step (default-on but
  toggleable; full design in `docs/internals/task-interpretation.md`). It filters user-authored text
  into task candidates (recognizing Argus's own `claude -p` prompts so they aren't mistaken for user
  tasks), then runs two passes — pass 1 segments tasks/chapters, pass 2 judges per-task
  outcome/frustration from the reconstructed prompt/response dialogue — via the shared LLM layer
  (`src/llm/`), defaulting to the `claude-cli` provider (a cheap local model). The per-interaction
  prompt/response text is kept **out of the stored interaction records** but is retained separately,
  **default-on (toggleable) and local-only**, in `resolved_interaction_text` (the `retainText`
  setting), never on the sync wire.

- **`cli.ts`** — The executable entry point (npm `bin`). Defines the subcommands (`serve`,
  `index` [+ `rebuild`/`refresh`/`delete` subcommands and `--watch`], `sync` [the upload, formerly
  `push`; + `--watch`], `run`, `status`, `config`, `secret`) with [citty](https://github.com/unjs/citty): each
  declares its own flags, `--help` scopes per subcommand, and flag types flow into the handlers. There
  is no default command: a bare `argus` (no subcommand) prints the usage/help. `serve` exposes only
  `--port`/`-p` and `--open`. `index refresh` takes space-separated session ids (per-session reindex,
  matching `index delete`); `--extract-tasks <true|false>` on `index`/`rebuild`/`refresh` overrides the
  `argus.json` task-interpretation setting for the run. (citty quirk: a parent command's `run` fires
  even after a subcommand dispatches, so `index`'s parent guards against double-running.) The
  store-maintenance bodies live in `index-ops.ts`; the long-running `--watch` loops and the
  orchestrator are in `watch.ts` / `run.ts` (see below).

- **`index-ops.ts`** — The `argus index` command bodies (`runIndex`, `runIndexRebuild` with its
  confirmation prompt, `runIndexRefresh`, `runIndexDelete`), extracted so both `cli.ts` and the watch
  loop share them. The only writers to the store. `runIndexRefresh` takes optional session ids: bare =
  full re-read; with ids = per-session reindex via `reindexSession` (in `indexing/pipeline.ts`). All
  three resolve task interpretation through `config.ts`, with an optional `--extract-tasks` override.

- **`backoff.ts`** — Shared loop primitives for the long-running commands: cancellable `sleep`, a
  jittered/capped `Backoff`, a `RepeatCollapser` (collapses repeated identical failure logs), and
  `superviseLoop` (restarts a crashing leg with backoff, exits on `AbortSignal`).

- **`watch.ts`** — `watchIndex` and `watchSync` (the `--watch` loops, factored so `run` calls them
  in-process). On a Hub auth failure `watchSync` parks the sync leg (by HTTP status) instead of
  crashing `run`. Both accept optional test seams. The push mechanics (`pushSnapshotForOpts`) live
  here too.

- **`run.ts`** — `argus run`: one foreground process, one `AbortController` + single SIGINT/SIGTERM
  handler, `Promise.all` of `watchIndex` + a supervised `serve` + `watchSync` against one shared
  store. `assertHomeResolved` is the fatal-startup guard for the service-manager minimal-env case.

## The wire contract (important)

Stable types come from the external package `@agentdeploymentco/argus-schema` (pinned to a git tag in
`package.json`). `types.ts` re-exports them and extends `Dashboard`/`SessionRow` with CLI-only fields
(e.g. `bySource`, `source`). The schema package is the single source of truth shared with `argus-hub`.

`sync` no longer assembles or uploads a `Dashboard`: `push.ts` uploads raw `resolved_*` rows and the
Hub aggregates them, so the old `PushPayloadSchema`-vs-`Dashboard` CI check is gone. The
`@agentdeploymentco/argus-schema` `Dashboard` type still backs the web app's
per-view response types (imported type-only by `web/src/types.ts`); the wire contract itself is being
reworked separately.

Not everything is on the wire: `TaskFact` and the task-interpretation fields (chapter span, outcome,
frustration) live in `store/store-contract.ts` and are **local-only** — they are not pushed by `sync`,
so adding/changing them needs no schema-package bump. `store/store-contract.ts` (the parse→store fact
contract, including `PARSED_FRAGMENT_CONTRACT_VERSION`) is separate from the
`@agentdeploymentco/argus-schema` wire contract.
