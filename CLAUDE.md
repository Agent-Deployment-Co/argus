# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Argus is a Bun + TypeScript CLI that audits local Claude Code and Codex usage. It reads
local session transcripts (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl`)
and either emits a self-contained HTML dashboard (`report`, the default) or pushes a
per-(org, user) snapshot to a private Cloudflare Worker backend (`push`). Nothing is uploaded
during `report`; all parsing is local.

The Worker + D1 dashboard backend lives in a **separate private repo**, `agentdeploymentco/argus-dash`.
This repo is the public CLI only.

## Commands

```bash
bun run src/index.ts [report] [--open]   # build the dashboard (entry point)
bun test                                  # run all tests (uses bun:test, zero extra deps)
bun test test/parse.test.ts               # run a single test file
bun test -t "dedup"                       # run tests matching a name
bun run typecheck                         # tsc --noEmit (also run in CI)
```

CI (`.github/workflows/ci.yml`) runs `bun x tsc --noEmit` then `bun test` on every push/PR.
There is no separate build step — `src/index.ts` is the executable `bin` (run directly by Bun).

## Architecture

The pipeline is a one-way data flow; each stage is its own module:

`parse.ts` → `aggregate.ts` → (`report.ts` HTML | `push.ts` snapshot)

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
  models are priced correctly.

- **`tool-categories.ts`** — Canonical tool/MCP parsing: `categorizeTool` (9 categories),
  `isMcpTool`, `parseMcpTool` (the `mcp__server__tool` split — requires ≥3 `__` segments,
  tool keeps any further `__`), and `toolDisplayName`. Both `parse.ts` and `aggregate.ts`
  use it so categorization and MCP server/tool naming remain consistent. `aggregate.ts`
  emits `byTool` (per-tool ranking) and `byToolCategory` (category rollup) from it.

- **`pricing.ts`** — USD/Mtok price table keyed by model *family* (substring match: opus/sonnet/haiku/gpt-5.x).
  Unknown models cost 0 and are tracked in `unpricedModels()`. Override prices via `~/.claude/argus-pricing.json`.

- **`inventory.ts`** — Reads `~/.claude/settings.json` (`enabledPlugins`) and `plugins/installed_plugins.json`
  to map skills (`plugin:skill`) to owning plugins and to surface **enabled-but-unused** plugins.

- **`summarize.ts`** — Per-session summaries. Default is a free heuristic; `--summarize` shells out to
  headless `claude -p` and caches results in `~/.claude/argus-cache.json`, keyed by session + last-activity
  timestamp (so re-runs are incremental).

- **`report.ts`** / **`chartjs.ts`** — Render the `Dashboard` to one self-contained HTML file with Chart.js
  inlined from `src/vendor/` (works fully offline). `report.ts` also supports a team/Worker mode (user
  selector) — that path is exercised by `argus-dash`, not the CLI.

- **`push.ts`** — Detects user (git email → `$USER@host`) and org (email domain), POSTs the snapshot to
  `<endpoint>/ingest` with a bearer token. The server is authoritative on org/token validation.

- **`paths.ts`** — All filesystem locations, honoring `CLAUDE_CONFIG_DIR`, `CODEX_HOME`/`CODEX_CONFIG_DIR`.

## The wire contract (important)

Stable types come from the external package `@agentdeploymentco/argus-schema` (pinned to a git tag in
`package.json`). `types.ts` re-exports them and extends `Dashboard`/`SessionRow` with CLI-only fields
(e.g. `bySource`, `source`). The schema package is the single source of truth shared with `argus-dash`.

`test/contract.test.ts` builds a dashboard from fixtures and validates it against the schema's
`PushPayloadSchema`, so any drift between the CLI's output and the wire contract **fails CI**. When
changing the `Dashboard` shape, update the schema package and bump its pinned version here in lockstep.

## Version control

Per global user preference: use `jj` (Jujutsu), never `git`, for all version control. See the `jj` skill.
Note `push.ts` does shell out to `git config user.email` to detect the user — that's a read, not a VCS op.
