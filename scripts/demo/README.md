# Demo data

`scripts/demo.ts` stands up a realistic, reproducible Argus demo in a sandbox and (optionally) opens
the web app on it. It exists for two things: **live demos** and **stable screenshots** for the public
docs. This file is the contract for how the demo data works, so you can tweak it later without
re-deriving the approach. Read it before changing `scenarios.ts` or `generate.ts`.

## Quick start

```bash
bun run demo                                  # seed into .demo/ and open the app
bun run scripts/demo.ts --no-serve            # seed only, print the serve command
bun run scripts/demo.ts --as-of 2026-07-01 --seed 42   # pin dates + seed for reproducible screenshots
bun test test/demo.test.ts                    # the guardrails below, as tests
```

Flags: `--out <dir>` (default `.demo/`, gitignored), `--as-of <YYYY-MM-DD>` (default today),
`--seed <n>` (default 42), `--serve`/`--no-serve`, `--port <n>`.

## The persona and world (keep this grounded)

All demo content is one coherent, obviously-fake company:

- The user is **Rachel** (`rachel@tyrell.example`, files under `/Users/rachel/...`) at **Tyrell
  Corporation**. She does **go-to-market knowledge work** (sales, marketing, revops, AI-ops), never
  software of her own. This matches Argus's real audience (see `docs/contributing/voice-and-tone.md`).
- **Keep everything grounded and realistic.** Tyrell and Rachel are a deliberately subtle nod. Do
  **not** add overt sci-fi (no "Off-World Colonies", "Nexus-6", "replicants", etc.). Companies Rachel
  researches must read like real B2B firms (Wallace Corp, Rosen Associates, Sebastian Design, Meridian
  Software). If a name would tip off a casual reader that this is a theme, don't use it.
- **Public-repo safety:** no real paths, names, emails, tokens, or transcript text. Real MCP/product
  names (hubspot, salesforce, notion, ...) are public and fine; the content around them is invented.

## Approach and why

Seed a synthetic `argus.db` **directly through the store API** (`openStore` -> `materializeSessions`
+ `writeSessionTasks`). We do **not** generate raw transcripts and run the pipeline, and we do **not**
commit a prebuilt `.db`.

- Direct seeding makes the task-interpretation views deterministic with no LLM, no `claude` CLI, and
  no network. It is the least code.
- It uses the real store types, so any store-contract change fails `bun run typecheck` or the tests
  instead of rotting silently (which a committed binary would).
- The generator is the committed source of truth; the `.db` is regenerated on demand into a gitignored
  sandbox, so the developer's real Argus store is never touched.

## Files

- **`scenarios.ts`** — the authored, reviewable data: `PROJECTS` (Rachel's GTM projects and their
  session templates and task pools) and `PLUGIN_CATALOG`. Edit this to change *what* the demo shows.
- **`generate.ts`** — the deterministic expander: turns scenarios into store records. Edit this to
  change *how* sessions are shaped. Holds the invariants below.
- **`../demo.ts`** — orchestration: seeds the store, writes the sandbox side-files, spawns `serve`.

## How to tweak

- **Add a project:** append a `ProjectScenario` to `PROJECTS` (slug, `source`, `model`, optional
  `secondaryModel`, `persona`, and `sessions`).
- **Add a session:** add a `SessionTemplate` (opening `title`, `tools`, `skills`, `files`, `turns`,
  `friction`, `tasks`, optional `instances` to repeat it across dates).
- **Add tasks:** each template's `tasks` is a **pool**; the generator takes 1-3 from it by session
  size (see below). Author the pool oldest-first; put the messiest/least-resolved task last.

## Invariants the generator guarantees (don't break these)

These keep every view populated and correct. If you change `generate.ts`, keep them true (the tests
check them):

- **Sources and their traits.** Only `claude` (Claude Code) and `cowork` (Cowork) carry friction;
  `codex` and `claude-chat` leave friction undefined. `claude-chat` usage is estimated (no cache
  buckets). No Gemini in the demo.
- **Only priced models.** Every `model` must match a pricing family in `src/pricing.ts` (opus /
  sonnet / haiku / gpt-5.x / codex-mini). No unpriced models (cost must be fully accounted).
- **Session ids** are `<source>:<uuid>`, except Claude Code, which is a **bare `<uuid>`** for legacy
  parity. Ids are derived deterministically from a stable per-session key, so they're reproducible.
- **Tasks tie to interactions.** Each session gets one interaction per task over a contiguous slice
  of its messages, messages carry their `interactionSeq`, and each task's timestamp matches its
  interaction's first message. This is what makes per-task token/tool metrics work (usage attributes
  to a task through its interaction). Without it, tasks show 0 tokens and no tools.
- **Task count scales with size:** 1-3 tasks per session, more for larger (higher-token) sessions,
  capped by the authored pool (`targetTaskCount`).
- **Message counts are set:** `agentMessages` = assistant turns, `userMessages` = turns plus tool
  results (user-role records), so neither shows blank.
- **Recommendation coverage.** The corpus is tuned to trigger unused-plugins, token-growth,
  high-interruptions, rejections, and frequent-compactions (via friction profiles and the plugin
  catalog). If you rebalance friction or plugins, re-check these still fire.
- **Determinism.** Everything flows from `--seed` and `--as-of`. Use the seeded PRNG (`makeRng`); do
  not use `Date.now()` or `Math.random()` in `generate.ts`.

## Isolation

`--out` (default `.demo/`) holds the sandbox. Seeding writes `<out>/data/argus.db` directly. `serve`
runs as a child process with `ARGUS_HOME=<out>` and `CLAUDE_CONFIG_DIR=<out>/claude`, so it reads the
demo store and the demo plugin inventory (`settings.json` + `plugins/installed_plugins.json`) that the
app loads from disk. `.demo/` is gitignored.

## Tests

`test/demo.test.ts` is the executable form of this contract: it seeds a temp store and asserts the
breakdowns, recommendations, per-task metrics, task-count-by-size distribution, id format, and message
counts. Run it after any change here.
