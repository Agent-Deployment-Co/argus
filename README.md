# Argus by ADC

Argus audits how you use Claude Code, Codex, and Gemini CLI. It reads local session
transcripts and can:

- Generate a self-contained HTML report for a point-in-time view of your usage.
- Push usage snapshots to the [Argus dashboard](https://argus.agentdeployment.co), where
  you can keep and analyze your data over time.

Reports include:

- Tokens and estimated cost over time
- Claude, Codex, and Gemini source breakdowns
- Skill, tool, MCP server, plugin, model, and project attribution
- Tools that return the most content to your context
- Per-session duration, tokens, cost, prompts, and summaries

## Quick start

Run `argus` directly with `npx`.

Print a compact overview in your terminal:

```bash
npx @agentdeploymentco/argus
```

Generate and open the full report:

```bash
npx @agentdeploymentco/argus report --open
```

The report is written to `argus-report.html` by default and works fully offline.

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
```

Without `--summarize`, Argus creates an instant heuristic summary from the first prompt,
skills, tools, and edited files. With `--summarize`, it uses `claude -p` to create a short
narrative and caches the result in `~/.claude/argus-cache.json`. Only new or changed
sessions are summarized again.

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
  billing. Override prices in `~/.claude/argus-pricing.json`:

  ```json
  { "gpt-5.5": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite5m": 0, "cacheWrite1h": 0 } }
  ```
