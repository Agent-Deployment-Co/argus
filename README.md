# Argus by ADC

Argus audits how you use Claude Code, Codex, and Gemini CLI. It reads local session
transcripts and can:

- **Serve an interactive dashboard** at a local web address (`serve`) — the preferred way to
  explore your usage.
- Generate a self-contained HTML report for a point-in-time snapshot you can share or open
  offline (`report`).
- Push usage snapshots to the [Argus dashboard](https://argus.agentdeployment.co), where
  you can keep and analyze your data over time (`push`).

Both the web app and the report include:

- Tokens and estimated cost over time
- Claude, Codex, and Gemini source breakdowns
- Skill, tool, MCP server, plugin, model, and project attribution
- Tools that return the most content to your context
- Per-session duration, tokens, cost, prompts, and summaries

## Quick start

Run `argus` directly with `npx`.

Argus's published CLI requires Node.js 20.17 or newer. The repository uses Bun for
development and tests, but the installed npm executable runs under Node.

Print a compact overview in your terminal:

```bash
npx @agentdeploymentco/argus report --console
```

Open the interactive dashboard in your browser (recommended):

```bash
npx @agentdeploymentco/argus serve --open
```

This starts a local web server (default `http://localhost:4242`) and opens it. Press `Ctrl-C`
to stop. Nothing leaves your machine — it reads your local transcripts and serves them locally.

Or generate a self-contained report file to share or open offline:

```bash
npx @agentdeploymentco/argus report --open
```

The report is written to `argus-report.html` by default and works fully offline.

## Web app

`serve` is the preferred, interactive way to explore your usage: the same breakdowns as the
report, in a live local web app that's the foundation for richer features over time. The report
remains the right tool when you want a single file to email, attach to CI, or open without a server.

```bash
npx @agentdeploymentco/argus serve --open          # http://localhost:4242
npx @agentdeploymentco/argus serve --port 8080      # choose a port (or set ARGUS_PORT)
```

| Flag | Description |
|------|-------------|
| `-p, --port <N>` | Local port to listen on (env `ARGUS_PORT`, default: `4242`) |
| `--open` | Open the dashboard in your browser once it's ready (macOS) |
| `--source`, `--since`, `--until`, `--project` | Same data filters as `report` |

The web app reads from your local session store (the same data `report` uses) and refreshes it
in the background; it does not re-parse every transcript on each page load.

## Report options

| Flag | Description |
|------|-------------|
| `--source <claude\|codex\|gemini\|all>` | Transcript source to parse (default: `all`) |
| `--since <YYYY-MM-DD>` | Include messages on or after this date |
| `--until <YYYY-MM-DD>` | Include messages on or before this date |
| `--project <substr>` | Include sessions whose working directory matches the value |
| `-o, --out <file>` | Output path (default: `argus-report.html`) |
| `--summarize` | Generate richer per-session summaries with `claude -p` |
| `--summarize-model <id>` | Model used for summaries |
| `--open` | Open the generated report (macOS) |
| `--json` | Write the aggregate data as JSON instead of HTML |
| `--console` | Print a compact overview in your terminal instead of writing a file |
| `--agentsview` | Import compatible AgentsView data when available (default) |
| `--no-agentsview` | Disable AgentsView import |
| `--agentsview-db <path>` | Read AgentsView data from a specific SQLite database path |
| `-h, --help` | Show help |

### Examples

```bash
# Custom output path
npx @agentdeploymentco/argus report -o ~/Desktop/usage.html --open

# One transcript source
npx @agentdeploymentco/argus report --source claude

# Date and project filters
npx @agentdeploymentco/argus report --since 2026-05-01 --until 2026-06-01
npx @agentdeploymentco/argus report --project argus

# Richer session summaries
npx @agentdeploymentco/argus report --summarize --open

# Raw aggregate data
npx @agentdeploymentco/argus report --json -o argus.json

# Control optional AgentsView import
npx @agentdeploymentco/argus report --no-agentsview
npx @agentdeploymentco/argus report --agentsview-db /path/to/agentsview.sqlite3
```

Without `--summarize`, Argus creates an instant heuristic summary from the first prompt,
skills, tools, and edited files. With `--summarize`, it uses `claude -p` to create a short
narrative and caches the result in `$ARGUS_CACHE_DIR/summaries.json` (macOS: `~/Library/Caches/argus/summaries.json`). Only new or changed
sessions are summarized again.

## Incremental cache

Argus stores parsed transcript fragments in a private local SQLite cache so unchanged
transcripts do not need to be reparsed on every run. The cache contains normalized usage,
session, tool, and auxiliary metadata; it does not change what `report` keeps local or what
`push` sends.

When a compatible local AgentsView database is available, Argus imports read-only provenance
into the same cache. Native transcript parsing remains authoritative for sources that have
local transcript fragments; AgentsView facts are used only for selected sources without native
fragments. Use `--no-agentsview` to disable this bridge.

Inspect or rebuild the cache when troubleshooting:

```bash
npx @agentdeploymentco/argus cache-status
npx @agentdeploymentco/argus cache-rebuild
```

## Keep and analyze data over time

Local reports show the transcripts currently available on your machine. The
[Argus dashboard](https://argus.agentdeployment.co) stores pushed snapshots so you can
analyze usage over time, compare users, filter the organization view, and review trends.

Sign in once, then push your current usage:

```bash
npx @agentdeploymentco/argus login
npx @agentdeploymentco/argus push
```

Argus identifies you from your configured git email, falling back to `$USER@host`. Override
the user id when needed:

```bash
npx @agentdeploymentco/argus push --user alice
```

Push accepts the same source, date, project, and summary filters as `report`:

```bash
npx @agentdeploymentco/argus push --source claude --since 2026-05-01
npx @agentdeploymentco/argus push --project client-app --summarize
```

Run `push` regularly to keep the dashboard current and build a useful history for analysis.
Pushing the same snapshot again does not double-count it.

## Data and accuracy

- **Local by default.** `report` reads transcripts and creates its output locally. Data is
  sent to the hosted dashboard only when you run `push`.
- **Transcript locations.** Argus reads `~/.claude`, `~/.codex`, and `~/.gemini` by default.
  Override them with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `CODEX_CONFIG_DIR`, and
  `GEMINI_CLI_HOME`.
- **Deduplication.** Resumed sessions can repeat earlier messages, and subagent transcripts
  live in nested directories. Argus walks recursively and deduplicates assistant messages by
  API message id.
- **Estimated cost.** Cost uses published API prices and may differ from subscription or plan
  billing. Override prices in `$ARGUS_CONFIG_DIR/pricing.json` (macOS: `~/Library/Application Support/argus/pricing.json`):

  ```json
  { "gpt-5.5": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite5m": 0, "cacheWrite1h": 0 } }
  ```
