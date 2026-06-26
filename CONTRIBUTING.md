# Contributing to Argus

This guide covers development of the Argus CLI. The hosted dashboard is maintained in a
separate private repository.

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
bun run dev                    # API + Vite together (random ports, per-worktree ./tmp store, opens browser)
bun run typecheck              # TypeScript checks (root src + web/)
bun test                       # Full test suite
bun test test/parse.test.ts    # One test file
bun test -t "dedup"            # Tests matching a name
bun run build:web              # Build the web app into dist/web
bun run dev:web                # Vite dev server for the web app (live reload)
bun run build                  # Build the distributable Node.js CLI (runs build:web first)
```

CI installs with the frozen lockfile, typechecks both the root and `web/`, runs the full test
suite, and verifies the web build.

## Architecture

The core data flow is:

```text
parse.ts -> aggregate.ts -> serve.ts or push.ts
```

- `src/cli.ts` is the executable entry point. It defines the subcommands with
  [citty](https://github.com/unjs/citty) (each declares its own flags and per-subcommand `--help`)
  and dispatches the web server, indexing, login, and upload commands.
- `src/dashboard-builder.ts` builds the analyzed `Dashboard` from the session store. Shared by
  the `sync` command and the web server.
- `src/parse.ts` reads Claude, Codex, and Gemini transcripts into normalized message and
  session records.
- `src/aggregate.ts` converts parsed records into the dashboard model and computes
  breakdowns and estimated cost.
- `src/serve.ts` runs the local web server (`argus serve`): a Hono app exposing the dashboard
  as a JSON API and serving the React web app from `dist/web`.
- `src/push.ts` detects user and organization metadata and sends a dashboard snapshot.
- `src/auth.ts` manages dashboard login credentials used by the CLI.
- `src/summarize.ts` creates the per-session heuristic summary.
- `src/inventory.ts` maps skills and MCP tools to installed plugins.
- `src/pricing.ts` contains model-family pricing and user override support.
- `src/tool-categories.ts` provides canonical tool categorization and MCP name parsing.
- `src/paths.ts` defines transcript, cache, settings, and credential locations.

## Parsing invariants

Transcript parsing is the most sensitive part of the CLI. Preserve these behaviors:

- Walk transcript directories recursively so nested subagent sessions are included.
- Deduplicate Claude assistant messages by API `message.id`; resumed and compacted sessions
  can append earlier messages again.
- Parse Claude, Codex, and Gemini through their source-specific transcript formats.
- Treat Codex and Gemini cached input as cache read because it is included in total input.
- Preserve Anthropic's separate 5-minute and 1-hour cache-write buckets.
- Associate tool results with the producing tool through `tool_use_id` or `call_id`.
- Use `tool-categories.ts` from both parsing and aggregation so tool names and categories
  remain consistent.

Cost must be calculated from individual messages before aggregation. A session can use
multiple models, so pricing combined token totals once would produce incorrect results.

## Web app

`argus serve` (`src/serve.ts`) serves an interactive React app from `web/`. See
[docs/web-app.md](docs/web-app.md) for the full design and rationale. The essentials for working
on it:

- **Dependencies.** Runtime deps add only `hono` + `@hono/node-server`. The frontend stack
  (`react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `@tanstack/react-router`,
  `@tanstack/react-query`, `@tanstack/react-table`, `chart.js`, `react-chartjs-2`) lives in
  **`devDependencies`** — it's pre-bundled into `dist/web` at build time, so it's never installed
  by end users.
- **Layout.** `web/` is its own Vite project with its own `web/tsconfig.json` (DOM + JSX libs,
  separate from the Bun/Node root config). Components live in `web/src/{routes,components,lib}`.
- **Type sharing.** `web/src/types.ts` re-exports the CLI `Dashboard` types from `src/` as
  **type-only** imports, so the `/api/snapshot` payload and the UI can't drift. Type-only imports
  are erased at build time — no server code reaches the browser bundle.
- **Build.** `bun run build:web` → `dist/web`. `bun run build` runs it before bundling the CLI.
  `dist/web` ships via the package `files: ["dist"]`. Note `.gitignore` has a broad `*.html` rule;
  a `!web/index.html` exception keeps the app's entry HTML tracked.
- **API + tests.** `serve.ts` splits `createApp()` (pure route wiring) from `startServer()` (cache
  + listening) so the routes are unit-testable. `test/serve.test.ts` builds a fixture snapshot,
  injects it into `createApp()`, and asserts `GET /api/snapshot` returns a payload that satisfies
  the wire contract — no real transcripts or network involved.
- **Charts.** Chart.js controllers must be registered (`web/src/lib/charts.ts`); react-chartjs-2
  does not auto-register them.

## Wire contract

Stable payload types come from `@agentdeploymentco/argus-schema`, which is shared with the
hosted dashboard. CLI-only fields extend those types in `src/types.ts`.

`test/contract.test.ts` builds a dashboard from fixtures and validates it against
`PushPayloadSchema`. When changing the pushed dashboard shape:

1. Update and release the schema package.
2. Bump the pinned schema version in `package.json`.
3. Update the CLI implementation and contract fixtures in the same change.

## Tests

The suite uses `bun:test` with no additional test framework. Coverage includes:

- Claude, Codex, and Gemini parsing and replay behavior
- Deduplication, cache accounting, and subagent discovery
- Tool, skill, MCP, file, and tool-result attribution
- Pricing and aggregation across model families
- Plugin inventory and skill ownership
- Per-session heuristic summaries
- Dashboard login and upload behavior
- The web app's JSON API
- The shared dashboard payload contract

Add focused tests for narrow changes. Broaden coverage when modifying transcript parsing,
shared aggregation behavior, or payload types.
