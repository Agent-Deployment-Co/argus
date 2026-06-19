# Argus by ADC

Argus audits how you use Claude Code, Codex, and Gemini CLI. It reads local session
transcripts and can:

- **Serve an interactive dashboard** at a local web address (`serve`) — the preferred way to
  explore your usage.
- Generate a self-contained HTML report for a point-in-time snapshot you can share or open
  offline (`report`).
- Upload usage snapshots to the [Argus dashboard](https://argus.agentdeployment.co), where
  you can keep and analyze your data over time (`sync`).
- **Run all of it as one always-on process** (`run`) — keep the local data current, serve the
  web app, and upload on a schedule, so the dashboard is live whenever you want it.

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

## The local store

Argus keeps your parsed sessions in a private local store so unchanged transcripts don't need to
be reparsed on every run. `report`, `serve`, and `sync` all read from it. The `index` command keeps
it current:

```bash
npx @agentdeploymentco/argus index                  # read new and changed sessions (fast, incremental)
npx @agentdeploymentco/argus index --watch           # keep reading on an interval (default every 5 min)
npx @agentdeploymentco/argus index --watch --interval 15
npx @agentdeploymentco/argus status                  # show the store location and per-source counts
```

| Command | Description |
|---------|-------------|
| `index` | Read new and changed sessions into the local store. |
| `index --watch [--interval N]` | Keep reading on an interval (N minutes, default 5). Runs until `Ctrl-C`. |
| `index refresh [<id>…]` | Bare: re-read every transcript from disk (sessions no longer on disk are kept). With session id(s): re-index just those sessions. |
| `index rebuild [--force]` | Rebuild from scratch — **drops sessions no longer on disk**. Prompts for confirmation unless `--force`. |
| `index delete <id>… \| --archived` | Permanently remove sessions from the store. |

When a compatible local AgentsView database is available, Argus imports read-only provenance
into the same store. Native transcript parsing remains authoritative for sources that have
local transcript fragments; AgentsView facts are used only for selected sources without native
fragments. Use `--no-agentsview` to disable this bridge.

## Task interpretation (opt-in)

Argus can interpret each session into the **tasks** you asked for and how they turned out — a
description, the span of the session it covers, and a judged outcome (success / failure / unclear)
with a frustration signal. This runs an AI model on each session, so it's **off by default**.

Turn it on in `argus.json` (under `$ARGUS_CONFIG_DIR`, macOS:
`~/Library/Application Support/argus/argus.json`):

```json
{ "taskExtraction": { "enabled": true, "provider": "claude" } }
```

With it enabled, `index` extracts tasks for sessions as it reads them. To try it on specific sessions
without enabling it globally, force it per run:

```bash
npx @agentdeploymentco/argus index refresh <session-id> --extract-tasks true
```

`--extract-tasks <true|false>` (on `index`, `index rebuild`, and `index refresh`) overrides the
config for that run. The `claude` provider uses `claude -p` with a fast, cheap model by default and
leaves no extra session behind. The reconstructed dialogue used to judge outcomes is never stored —
only the task description and outcome are. See
[docs/configuration.md](docs/configuration.md) and
[docs/task-interpretation.md](docs/task-interpretation.md).

## Keep and analyze data over time

Local reports show the transcripts currently available on your machine. The
[Argus dashboard](https://argus.agentdeployment.co) stores pushed snapshots so you can
analyze usage over time, compare users, filter the organization view, and review trends.

Sign in once, then upload your current usage with `sync`:

```bash
npx @agentdeploymentco/argus login
npx @agentdeploymentco/argus sync
```

Argus identifies you from your configured git email, falling back to `$USER@host`. Override
the user id when needed:

```bash
npx @agentdeploymentco/argus sync --user alice
```

`sync` accepts the same source, date, project, and summary filters as `report`:

```bash
npx @agentdeploymentco/argus sync --source claude --since 2026-05-01
npx @agentdeploymentco/argus sync --project client-app --summarize
```

Run `sync` regularly to keep the dashboard current and build a useful history for analysis.
Uploading the same snapshot again does not double-count it. To upload continuously, add `--watch`
(every N minutes, default 5) — it retries quietly through network drops and resumes once you're back
online:

```bash
npx @agentdeploymentco/argus sync --watch --interval 30
```

## Run as a service

`argus run` does all three jobs in one long-running process — it reads new sessions, serves the web
app, and uploads on a schedule, against one shared store:

```bash
npx @agentdeploymentco/argus run                     # serve on :4242, index + upload every 5 min
npx @agentdeploymentco/argus run --port 8080 --index-interval 10 --sync-interval 30
```

It runs in the **foreground** and logs to standard output, so a service manager can supervise it,
capture its logs, and restart it. Each job is supervised independently: if one hiccups it restarts on
its own without stopping the others, and the upload job stays dormant (rather than failing) until you
`argus login`. `Ctrl-C` or `SIGTERM` shuts it down cleanly.

Point your OS service manager at it. systemd (`~/.config/systemd/user/argus.service`):

```ini
[Service]
ExecStart=/usr/local/bin/argus run
Restart=on-failure
# Service managers launch with a minimal environment. Argus needs to find your home directory to
# locate transcripts and the store — set HOME (or ARGUS_DATA_DIR + ARGUS_CONFIG_DIR) explicitly.
Environment=HOME=%h
```

launchd (`~/Library/LaunchAgents/co.agentdeployment.argus.plist`): set `ProgramArguments` to
`[…/argus, run]`, with `RunAtLoad` and `KeepAlive` true.

## Data and accuracy

- **Local by default.** `report`, `serve`, and `index` read transcripts and work entirely on your
  machine. Data is sent to the hosted dashboard only when you run `sync` (including `sync --watch`,
  or the upload job inside `run`).
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
