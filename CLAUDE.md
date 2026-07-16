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
`sync` (formerly `push`) uploads per-(org, user) usage data to an **Argus Hub** — a hosted backend a
company runs to pool its users' usage.
`run` ties the long-running pieces together (`index --watch` + `serve`, plus `sync --watch` when a
Hub is configured) in one supervised process — this is what the desktop app runs. Nothing is
uploaded during `serve`/`index`; the only data that ever leaves the machine is what `sync` sends.

This repo is the public CLI, its web app (`web/`), and the desktop tray shell (`desktop/`). The
Hub's own code (the backend `sync` uploads to) lives in a **separate public repo**,
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
bun run desktop:build                     # build the Tauri tray app (per-OS bundle) → desktop/src-tauri/target/**
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

The full module-by-module map lives in `docs/internals/architecture.md`, with per-subsystem design
docs alongside it (`web-app.md`, `configuration.md`, `llm-providers.md`, `task-interpretation.md`).
What follows is the load-bearing set — the invariants and gotchas worth keeping in context, the kind
you'd cause a bug by not knowing:

- **Accuracy lives in the producers** (`indexing/parse/producers/*`, one per source: `claude`,
  `claude-chat`, `cowork`, `codex`, `gemini`). They walk directories **recursively** so subagent
  transcripts (`<session>/subagents/*.jsonl`) are included, and **dedupe** assistant messages by API
  `message.id` (first wins) because resumed/compacted sessions re-append earlier messages verbatim.
  Claude and Codex have **different transcript shapes**, parsed by separate branches; cache accounting
  splits Anthropic's 5m/1h ephemeral buckets and treats Codex `cached_input_tokens` as a cache **read**.
- **Indexing is the sole writer of the reconciled session data** (`argus.db`'s `resolved_*` rows): it
  reconciles then materializes at write time, so consumers `SELECT` finished rows and never reconcile
  on read. `serve` and `sync` write too, but only their own state — `serve` persists user actions
  (labels, hidden sessions, settings), `sync` its upload cursors — never the session data.
- **Interpret runs *after* materialize**, as a decoupled, throttled, **default-on** (toggleable) drain
  — not between reconcile and materialize. Materialize writes only structural rows (**no
  interpretations**); interpret then writes the model's per-session **title + summary** and its
  **tasks** (`resolved_tasks`), stamping each interaction's `task_seq`.
- **No monolithic `Dashboard`.** Each `serve` view is its own small endpoint — a promoted store read
  plus a pure builder in `api/` — with no server-side cache; `sync` uploads reconciled rows (plus
  labels) that the Hub aggregates. `web/src/types.ts` imports the response types **type-only** from
  `src/`, so the API payload and the UI can't drift.
- **What crosses the sync wire, and what doesn't.** `sync` uploads the reconciled rows *and the
  interpretations*: sessions (with the model's title/summary), usage, `resolved_tasks` (the full
  `TaskFact` — outcome, frustration, signals), interactions (with `task_seq`), invocations, and user
  **labels**. Only two things never leave the machine: the retained prompt/response **text**
  (`resolved_interaction_text`, toggleable via `retainText`) and **BYO API keys** (`secrets.ts`) — so
  the interpretations *derived from* the text upload, but the raw text does not.
- **Canonical tool/MCP parsing lives in `tool-categories.ts`** (`categorizeTool`, `parseMcpTool` — the
  `mcp__server__tool` split). Route through it so categorization and MCP naming stay consistent.
- **All LLM access goes through `src/llm/`.** `registry.ts` is the single source of truth (adding a
  provider is one descriptor + one registry entry); `complete()` never throws
  (off/no-key/network/bad-shape → `ok:false`), so consumers branch on `ok`, not exceptions.
- **Friction signals are Claude-only** (interruptions, permission rejections, compactions, turn
  durations). Codex/Gemini sessions leave friction **undefined** (unknown), not zero.
- **Settings live in `config.ts` / `argus.json`,** resolved through one chain: `managed > flag > env
  > argus.json > default` (the top `managed` layer is org-managed MDM settings, `managed-config.ts`).
  The CLI (`cli.ts`, on citty) wraps the pipeline commands (`index`/`serve`/`sync`/`run`) plus
  `status`, `search` (full-text over sessions), `config`, and `secret`; `run` supervises
  `index --watch` + `serve` (+ `sync --watch`) in one process.
- **The desktop app (`desktop/`) is a Tauri tray shell around the CLI** (macOS and Windows) — how most
  users run Argus. It spawns `argus run` as a bundled sidecar and proxies a fixed front-door port
  (default `4242`) so the browser dashboard survives sidecar restarts; it auto-updates. Native code is
  `desktop/src-tauri/` (sidecar supervision in `lib.rs`, the front-door proxy in `proxy.rs`).

## The wire contract (important)

`Dashboard`/`SessionRow` (and the usage/day/plugin row types) are plain local types in `types.ts`,
extended there with CLI-only fields (e.g. `bySource`, `source`). They used to come from an external
`@agentdeploymentco/argus-schema` package; that dependency was retired once it was down to type-only
imports (the Hub backend had inlined its own copies and dropped it too).

`sync` no longer assembles or uploads a `Dashboard`: `push.ts` uploads the reconciled rows — sessions
(with model title/summary), usage, `resolved_tasks`, interactions, invocations — plus session
`labels`, and the Hub aggregates them (the old `PushPayloadSchema`-vs-`Dashboard` CI check is gone).
`Dashboard` still backs the web app's per-view response types (imported type-only by `web/src/types.ts`
from `src/types.ts`); the wire contract itself is being reworked separately.

Two things stay off the wire entirely: the retained prompt/response text (`resolved_interaction_text`)
and BYO API keys (`secrets.ts`). The task *interpretations* built from that text (outcome, frustration,
chapter span) do upload — the raw text doesn't. Separately, `store/store-contract.ts` (the parse→store
fact contract, including `PARSED_FRAGMENT_CONTRACT_VERSION`) is its own contract, distinct from the
`Dashboard`/`SessionRow` types above.
