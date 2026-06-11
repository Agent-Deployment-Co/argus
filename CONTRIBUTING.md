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
bun run src/index.ts
bun run src/index.ts report --open
```

## Development commands

```bash
bun run typecheck              # TypeScript checks
bun test                       # Full test suite
bun test test/parse.test.ts    # One test file
bun test -t "dedup"            # Tests matching a name
bun run build                  # Build the distributable Node.js CLI
```

CI installs with the frozen lockfile, runs the typecheck, and runs the full test suite.

## Architecture

The core data flow is:

```text
parse.ts -> aggregate.ts -> report.ts or push.ts
```

- `src/index.ts` parses CLI options, applies filters, coordinates summaries, and dispatches
  the terminal overview, HTML report, login, and push commands.
- `src/parse.ts` reads Claude, Codex, and Gemini transcripts into normalized message and
  session records.
- `src/capability-events.ts` defines source-neutral skill/tool/MCP events, outcome
  assessment invariants, and bounded evidence handling.
- `src/aggregate.ts` converts parsed records into the dashboard model and computes
  breakdowns and estimated cost.
- `src/report.ts` renders the self-contained HTML report.
- `src/console-report.ts` renders the compact terminal overview.
- `src/push.ts` detects user and organization metadata and sends a dashboard snapshot.
- `src/auth.ts` manages dashboard login credentials used by the CLI.
- `src/summarize.ts` creates heuristic summaries and optionally invokes `claude -p`.
- `src/inventory.ts` maps skills and MCP tools to installed plugins.
- `src/pricing.ts` contains model-family pricing and user override support.
- `src/tool-categories.ts` provides canonical tool categorization and MCP name parsing.
- `src/paths.ts` defines transcript, cache, settings, and credential locations.

The hosted dashboard renderer also uses `renderHtml`, so report changes must continue to
support the optional team-view fields in `RenderOptions`.

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
- Preserve source invocation IDs and timestamps so capability outcomes can be enriched
  without source-specific aggregation logic.
- Treat an invocation with no assessed result as `unknown`, never as implicit success.

See [docs/capability-events.md](docs/capability-events.md) for capability-event semantics,
source mappings, and evidence privacy constraints.

Cost must be calculated from individual messages before aggregation. A session can use
multiple models, so pricing combined token totals once would produce incorrect results.

## Report assets

The HTML report must remain self-contained and usable offline.

- Chart.js is vendored in `src/vendor/`.
- Aleo and Poppins webfonts are vendored and embedded by `src/brand.ts`.
- Keep third-party licenses in `src/vendor/`.
- Run the production build when changing asset loading; source execution and the bundled
  Node.js CLI resolve assets differently.

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
- Session summaries
- Dashboard login and push behavior
- Console and HTML report rendering
- The shared dashboard payload contract

Add focused tests for narrow changes. Broaden coverage when modifying transcript parsing,
shared aggregation behavior, payload types, or report rendering.
