# Argus

Audit how you actually use Claude Code and Codex. Reads your local session transcripts
(`~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`) and produces a
**self-contained HTML dashboard**:

- **Tokens & cost over time** — per day, stacked by token class (input / output / cache read / cache write).
- **Claude vs Codex breakdown** — sessions, messages, tokens, and estimated cost by transcript source.
- **Skill attribution** — which Claude skills you invoke and how many tokens each consumes (exact: usage and the active skill are recorded on the same message).
- **Tools** — every tool call ranked by use and folded into categories (file-io / shell / agent / web / planning / todo / skill / mcp / other). Tool categorization and MCP `server · tool` name splitting follow [`cc-lens`](https://github.com/Arindam200/cc-lens).
- **MCP servers** — call counts and which tools you actually use per server.
- **Heaviest tool results** — which tools dump the most tokens *into context* (e.g. big `Read`/`Bash` outputs) — useful for trimming context bloat.
- **Plugins** — usage folded per plugin, including **enabled-but-never-used** plugins (candidates to disable; every enabled plugin's skills/MCP tools add context overhead before you even prompt).
- **Per-session table** — project, duration, tokens, cost, and a summary.

It complements [`ccusage`](https://github.com/ryoppippi/ccusage) (which covers raw
token/cost-over-time and the statusline) by adding the attribution and session-summary
views ccusage doesn't.

## Usage

Requires [Bun](https://bun.sh) (≥1.2).

```bash
bun run src/index.ts --open
```

### Options

| Flag | Description |
|------|-------------|
| `--source <claude\|codex\|all>` | transcript source to parse (default `all`) |
| `--since <YYYY-MM-DD>` | only include messages on/after this date |
| `--until <YYYY-MM-DD>` | only include messages on/before this date |
| `--project <substr>` | only include sessions whose cwd matches `substr` |
| `-o, --out <file>` | output path (default `argus-report.html`) |
| `--summarize` | generate per-session **LLM** summaries via headless `claude -p` (cached) |
| `--summarize-model <id>` | model for summaries, e.g. `claude-haiku-4-5-20251001` |
| `--open` | open the report when done (macOS) |
| `--json` | write the raw aggregate as JSON instead of HTML |
| `-h, --help` | help |

### Examples

```bash
# Generate the report without opening it (writes ./argus-report.html)
bun run src/index.ts

# Custom output path, then open it
bun run src/index.ts -o ~/Desktop/usage.html --open

# Only Claude transcripts (or codex / all)
bun run src/index.ts --source claude

# Limit by date range or project
bun run src/index.ts --since 2026-05-01 --until 2026-06-01
bun run src/index.ts --project argus

# Richer per-session summaries via headless `claude -p` (cached, incremental)
bun run src/index.ts --summarize --open

# Raw aggregate as JSON instead of HTML
bun run src/index.ts --json -o argus.json
```

### Session summaries

Without `--summarize` you get a free, instant **heuristic** summary per session
(first prompt · skills used · top tools · files edited). With `--summarize`, each
session is summarized by `claude -p` into a 2–3 sentence narrative. Summaries are
cached in `~/.claude/argus-cache.json`, keyed by session + last-activity timestamp,
so re-runs only summarize new or changed sessions.

## Team mode (persist over time, multiple users, multiple orgs)

argus can push each person's usage to a shared **Cloudflare Worker + D1** backend, which
persists snapshots over time and serves a per-org dashboard (filter by user, compare, trends).

Data is **multi-tenant**: every snapshot belongs to an `(org, user)`. Each org has its own
token, and **orgs are sealed from each other** — a token can only read/write its own org.

The dashboard backend (Cloudflare Worker + D1) lives in a **separate private repo**,
`agentdeploymentco/argus-dash`; this public CLI just produces and pushes snapshots to it.

```bash
# Interactive login: opens the browser, then caches refreshable OAuth credentials.
export ARGUS_ENDPOINT=https://argus.agentdeployment.co
argus login
argus push                       # user = git email (else $USER@host)
argus push --user alice          # override the user id
```

The Access application must have **Managed OAuth** enabled. Under its Managed OAuth
settings, enable **dynamic client registration** and **Allow loopback clients** so the
browser can return to Argus on `http://127.0.0.1:<port>/callback`. Argus uses authorization
code + PKCE, stores the access and refresh tokens in `~/.claude/argus-token.json` with mode
`0600`, and refreshes expired access tokens automatically.

For unattended CI or cron jobs, use a Cloudflare Access service token instead of browser login:

```bash
export CF_ACCESS_CLIENT_ID=<service-token-client-id>
export CF_ACCESS_CLIENT_SECRET=<service-token-client-secret>
argus push
```

- **User** is auto-detected from your git email (override `--user` / it's the part before `@`).
- **Org** comes from your authenticated Cloudflare Access identity. You can override it with
  `--org` / `ARGUS_ORG`, but the server validates the override against the authenticated org.

Each `push` reparses your transcripts and sends a full snapshot; the Worker **replaces** that
`(org, user)`'s rows (idempotent — re-pushing never double-counts). Then open the dashboard at
**https://argus.agentdeployment.co** (deployed behind Cloudflare Access / SSO):

- `/` — dashboard for your org. In production you sign in via SSO and your org is derived from
  your email domain; locally it falls back to a token sign-in. `?user=all` aggregates everyone
  in your org; `?user=<id>` drills into one.
- `/api/dashboard?user=…` — same data as JSON (`Authorization: Bearer <token>` header or cookie)
- `POST /ingest` — snapshot ingest (bearer token → org)

`push` honors the same `--since` / `--until` / `--project` / `--summarize` filters as `report`.

Deploying/running the dashboard itself (custom domain, Cloudflare Access SSO, D1) is documented
in the private `argus-dash` repo.

## Tests

`bun test` (zero extra deps — uses `bun:test`). Covers parsing (Claude dedup, recursive subagent walk,
cache 5m/1h split, Codex cached-input split, tool/skill/MCP extraction, result-token attribution), pricing, aggregation,
inventory/skill→plugin mapping, heuristic summaries, and org detection. A **contract test** builds
a dashboard from a fixture transcript and validates it against `@agentdeploymentco/argus-schema`'s
`PushPayloadSchema`, so drift between the CLI's output and the wire contract fails in CI.

## Notes on accuracy

- **Deduplication.** Resumed/compacted sessions re-append earlier messages verbatim;
  subagent turns live in `<session>/subagents/*.jsonl`. argus walks recursively and
  dedupes assistant messages by API `message.id` so tokens aren't multi-counted — the
  same approach `ccusage` uses. Token totals reconcile with `ccusage` within a few
  percent on output / cache-read / cache-write (the buckets that are 99%+ of usage).
- **Cost** uses Anthropic and OpenAI API list prices. Anthropic cache writes use the
  5-minute / 1-hour ephemeral split; Codex/OpenAI cached input is treated as cache
  read because Codex reports it as a subset of total input tokens. Override any price
  via `~/.claude/argus-pricing.json`:
  ```json
  { "gpt-5.5": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite5m": 0, "cacheWrite1h": 0 } }
  ```
  (argus and ccusage can differ on absolute cost — notably ccusage's pricing snapshot
  may not yet include the newest model ids. Codex plan credits can also differ from API
  dollars. These are estimates; if you're on a flat-rate plan, treat cost as directional.)
- Reads `CLAUDE_CONFIG_DIR` if set, else `~/.claude`; reads `CODEX_HOME` or
  `CODEX_CONFIG_DIR` if set, else `~/.codex`. Nothing is uploaded; all parsing is local.
- The generated HTML inlines Chart.js (`src/vendor/`) so it works fully offline.
