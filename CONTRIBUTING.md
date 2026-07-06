# Contributing to Argus

This guide covers development of the Argus CLI. The hosted dashboard (Argus Hub) is maintained in a
separate public repository, `agentdeploymentco/argus-hub`.

## Setup

Argus requires [Bun](https://bun.sh) 1.2 or newer.

```bash
bun install
```

Run the CLI directly from source:

```bash
bun run src/cli.ts
bun run src/cli.ts serve --open
```

Run the web app from source (build the UI once, then serve it):

```bash
bun run build:web                 # build web/ into dist/web
bun run src/cli.ts serve --open # serve it at http://localhost:4242
```

For live-reloading UI development, use the combined dev script:

```bash
bun run dev
```

This runs both halves with one command (see `scripts/dev.sh`):

- The **API server** (`argus serve` under `bun --watch`) — restarts on any change under `src/`.
- The **Vite dev server** for `web/` — hot-reloads the browser on changes under `web/src/**`.

Vite proxies `/api` to the API server, so the two talk to each other. The script opens the web
app in your browser automatically once Vite is listening. `Ctrl-C` stops both cleanly.

A few conveniences make it safe to run several worktrees' dev servers at once:

- **Random free ports.** Both servers bind random unused ports by default, so concurrent dev
  servers never collide. Pin them with `ARGUS_PORT=<n>` (the API port — `argus serve` reads this
  env var as its default port too) and `WEB_PORT=<n>` (the Vite port). `ARGUS_PORT` doubles as the
  proxy target Vite points `/api` at.
- **Per-worktree store + config.** `ARGUS_HOME` defaults to this worktree's `./tmp`, so the local
  store lands in `./tmp/data` and config in `./tmp/config` — each worktree gets its own isolated
  data, and `rm -rf tmp` resets it. Override with `ARGUS_HOME=<dir>` (or the granular
  `ARGUS_DATA_DIR`/`ARGUS_CONFIG_DIR` vars, which win over `ARGUS_HOME`) to point at a shared store.

```bash
ARGUS_PORT=4242 bun run dev          # pin the API port
ARGUS_HOME=~/.argus bun run dev      # use a shared store/config instead of the worktree's ./tmp
```

A fresh worktree starts with an empty local store under `./tmp` until you index into it
(`bun run src/cli.ts index`). To run the two halves by hand instead, start them in separate
terminals: `bun run src/cli.ts serve --port 4242` and `bun run dev:web` (which proxies `/api` →
4242).

## Development commands

```bash
bun run dev                        # API + Vite together (random ports, per-worktree ./tmp store, opens browser)
bun run typecheck                  # TypeScript checks (root src + web/)
bun test                           # Full test suite
bun test test/parse-claude.test.ts # One test file
bun test -t "dedup"                # Tests matching a name
bun run build:web                  # Build the web app into dist/web
bun run dev:web                    # Vite dev server for the web app (live reload)
bun run build:compile              # Compile a self-contained CLI binary → dist/argus (runs build:web first)
bun run build:npm                  # Build the publishable npm package set → dist/npm/*
```

There is no Node-targeted bundle: the CLI compiles to a self-contained binary with
`bun build --compile` (it uses `bun:sqlite`, so it needs no Node/node-gyp). `build:npm` emits
per-OS packages under `dist/npm/` — a launcher package plus prebuilt-binary packages it pulls in as
optional dependencies. The web app builds to `dist/web` and ships beside each binary.

CI installs with the frozen lockfile, typechecks both the root and `web/`, runs the full test
suite, and verifies the web build.

## Documentation

The docs site is a [VitePress](https://vitepress.dev) project under `docs/`, published to
[argus.agentdeployment.co](https://argus.agentdeployment.co) on every merge to `main` that touches
`docs/`. It is the canonical source for people *using* Argus; the root README points there and keeps
only a condensed CLI reference.

```bash
bun run docs:dev      # live-reloading local preview
bun run docs:build    # build the static site (catches dead links)
bun run docs:preview  # serve the built output
```

Before writing or editing pages, read the authoring guides in
[`docs/contributing/`](docs/contributing/README.md): voice and tone, and technical writing. They
keep the docs consistent and on-voice. (They live in the repo but are excluded from the published
site.)

## Architecture

The pipeline is a one-way data flow, and `src/` is laid out by stage (full detail in
[docs/internals/architecture.md](docs/internals/architecture.md)):

```text
indexing/ (Discover → Parse → Reconcile → Interpret → Materialize) → store/ → (api/serve.ts | push.ts)
```

Neither read path assembles a monolithic dashboard. `serve` answers one small endpoint per view,
each reading only what it needs straight off the local store (`argus.db`). `sync` uploads raw
`resolved_*` rows that the Hub aggregates server-side.

The stage directories:

- **`src/indexing/`** — the pipeline: `pipeline.ts` (coordinator), `discover.ts`, `producer.ts`,
  `reconcile.ts`, `friction.ts`, `parse/producers/*`, and `interpret/*`.
- **`src/store/`** — the local SQLite store (`store.ts`, `store-contract.ts`, `session-store.ts`).
  `serve` and `sync` both read from it; the `index` commands are its only writers.
- **`src/reporting/`** — `aggregate.ts` (per-session row assembly + plugin folding),
  `dashboard-builder.ts` (shared source-selection helpers), `inventory.ts`.
- **`src/api/`** — the HTTP layer for `serve`: `serve.ts` (the Hono server + routes) plus the
  per-view response builders (`usage.ts`, `tools.ts`, `plugins.ts`, `health.ts`,
  `recommendations.ts`, `session-list.ts`, `task-metrics.ts`, `settings.ts`, `debug-info.ts`).
  Nothing here is used by the `sync`/CLI pipeline.

Cross-cutting modules and the CLI/runtime layer stay at `src/` root:

- `src/cli.ts` — the executable entry point (npm `bin`). Defines the subcommands with
  [citty](https://github.com/unjs/citty): `serve`, `index` (+ `rebuild`/`refresh`/`delete` and
  `--watch`), `sync` (+ `--watch`), `run`, `status`, `config`, and `secret`. Each declares its own
  flags and per-subcommand `--help`.
- `src/index-ops.ts` — the `argus index` command bodies (the only writers to the store), shared by
  `cli.ts` and the watch loop.
- `src/watch.ts` / `src/run.ts` — the long-running `--watch` loops and the `argus run` orchestrator
  (one foreground process supervising index + serve + sync against one shared store). `backoff.ts`
  holds the shared loop primitives.
- `src/indexing/parse/producers/*` — per-source readers (claude, codex, gemini, cowork,
  claude-chat) that turn raw `.jsonl` transcripts into normalized facts. The most subtle layer;
  accuracy lives here.
- `src/reporting/aggregate.ts` — `buildSessionRow` turns one session's messages + metadata into a
  `SessionRow` (including per-session health and friction); `foldPlugins` folds per-skill and
  per-MCP-server usage into per-plugin rows. Cost is priced per message here.
- `src/api/serve.ts` — the Hono app: `createApp()` (route wiring) + `startServer()` (listening),
  serving the React/Vite SPA from `dist/web` and the per-view JSON API.
- `src/push.ts` — the upload mechanics behind `argus sync`: detects user and org metadata and POSTs
  raw `resolved_*` rows to the Hub.
- `src/llm/` — the shared LLM access layer (a provider registry dispatched through one `complete()`;
  the first consumer is task interpretation). See
  [docs/internals/llm-providers.md](docs/internals/llm-providers.md).
- `src/secrets.ts` — BYO API-key storage (platform keychains behind an injectable seam). Local-only,
  never on the sync wire.
- `src/pricing.ts` — model-family pricing (substring match) with `pricing.json` overrides.
- `src/tool-categories.ts` — canonical tool categorization and MCP name parsing, used by both the
  producers and `reporting/aggregate.ts`.
- `src/config.ts` — the `argus.json` settings store and the `flag > env > argus.json > default`
  resolver.
- `src/paths.ts` — all filesystem locations, honoring `CLAUDE_CONFIG_DIR`, `CODEX_HOME`/
  `CODEX_CONFIG_DIR`, and the `ARGUS_HOME`/`ARGUS_DATA_DIR`/`ARGUS_CONFIG_DIR` overrides.

## Parsing invariants

Transcript parsing (`src/indexing/parse/producers/*`) is the most sensitive part of the CLI.
Preserve these behaviors:

- Walk transcript directories recursively so nested subagent sessions
  (`<session>/subagents/*.jsonl`) are included.
- Deduplicate Claude assistant messages by API `message.id`; resumed and compacted sessions
  can append earlier messages again.
- Parse each source through its own transcript format. Claude usage comes from `assistant`
  messages with `message.usage`; Codex usage comes from `event_msg` `token_count` events.
- Treat Codex and Gemini cached input as cache read because it is included in total input.
- Preserve Anthropic's separate 5-minute and 1-hour cache-write buckets.
- Associate tool results with the producing tool through `tool_use_id` or `call_id`.
- Use `tool-categories.ts` from both parsing and aggregation so tool names and categories
  remain consistent.

Cost must be calculated per message before aggregation. A session can use multiple models, so
pricing combined token totals once would produce incorrect results.

## Web app

`argus serve` (`src/api/serve.ts`) serves an interactive React app from `web/`. See
[docs/internals/web-app.md](docs/internals/web-app.md) for the full design and rationale. The
essentials for working on it:

- **Dependencies.** Runtime deps add only `hono` + `@hono/node-server`. The frontend stack
  (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@tanstack/react-router`,
  `@tanstack/react-query`, `@tanstack/react-table`, `chart.js`, `react-chartjs-2`) lives in
  **`devDependencies`** — it's pre-bundled into `dist/web` at build time, so it's never installed
  by end users.
- **Layout.** `web/` is its own Vite project with its own `web/tsconfig.json` (DOM + JSX libs,
  separate from the Bun/Node root config). Components live in `web/src/{routes,components,lib}`.
- **Per-view endpoints, no monolithic snapshot.** Each dashboard view has its own small endpoint
  (`/api/usage/daily`, `/api/usage/by-model`, `/api/skills`, `/api/tools/*`, `/api/plugins`,
  `/api/health`, `/api/recommendations`, `/api/sessions`, `/api/session/:id`, …), built on demand
  with no server-side cache — the client's React Query `staleTime` absorbs reloads. There is no
  `/api/snapshot`.
- **Type sharing.** `web/src/types.ts` re-exports the CLI `Dashboard` types from `src/` as
  **type-only** imports, so the API payloads and the UI can't drift. Type-only imports are erased at
  build time — no server code reaches the browser bundle.
- **Build.** `bun run build:web` → `dist/web`; `bun run build:compile` runs it before compiling the
  CLI binary. `dist/web` ships via the package `files: ["dist"]`. Note `.gitignore` has a broad
  `*.html` rule; a `!web/index.html` exception keeps the app's entry HTML tracked.
- **API + tests.** `serve.ts` splits `createApp()` (pure route wiring, with injectable view
  readers) from `startServer()` (store + listening) so the routes are unit-testable.
  `test/serve.test.ts` injects fake readers into `createApp()` and asserts each endpoint's contract;
  `test/dashboard-views.test.ts` covers the pure view builders in `src/api/*` directly — no real
  transcripts or network involved.
- **Charts.** Chart.js controllers must be registered (`web/src/lib/charts.ts`); react-chartjs-2
  does not auto-register them.

## Wire contract

Stable payload types come from `@agentdeploymentco/argus-schema` (pinned to a git tag in
`package.json`), which is shared with Argus Hub. `src/types.ts` re-exports them and extends
`Dashboard`/`SessionRow` with CLI-only fields.

`sync` no longer assembles or uploads a `Dashboard`: `push.ts` uploads raw `resolved_*` rows and the
Hub aggregates them server-side, so there is no dashboard-vs-schema contract test. The schema
package's `Dashboard` type still backs the web app's per-view response types (imported type-only by
`web/src/types.ts`).

Not everything is on the wire. `TaskFact` and the task-interpretation fields (chapter span, outcome,
frustration), along with retained interaction text, live in `src/store/store-contract.ts` and are
**local-only** — they are never pushed by `sync`, so adding or changing them needs no schema-package
bump. When you *do* change the pushed row shape:

1. Update and release the `@agentdeploymentco/argus-schema` package.
2. Bump the pinned schema version in `package.json`.
3. Update the CLI implementation in the same change.

## Tests

The suite uses `bun:test` with no additional test framework. Coverage includes:

- Claude, Codex, Gemini, Cowork, and Claude Chat parsing and replay behavior
- Deduplication, cache accounting, incremental indexing, and subagent discovery
- Reconciliation and friction detection
- Tool, skill, MCP, file, and tool-result attribution
- Pricing and per-session aggregation across model families
- Plugin inventory and skill ownership
- Per-session heuristic summaries and task extraction
- The local store and its fact contract
- Settings resolution and the shared LLM layer
- Hub credentials and upload behavior
- The web app's JSON API and per-view builders

Add focused tests for narrow changes. Broaden coverage when modifying transcript parsing,
shared aggregation behavior, the store contract, or payload types.
