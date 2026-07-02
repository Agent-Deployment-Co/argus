# Task interpretation: chapters, attribution, and outcome

The mechanical layers (parse → reconcile) extract **facts** from transcripts. Task interpretation is a
separate, opt-in layer that derives **interpretations** the transcript doesn't state directly: what
the user was trying to do, and whether it worked. It runs an AI model per session, so it's off by
default and gated by config.

Conceptually, indexing is:

```
Discover → Parse → Reconcile → Interpret (opt-in) → Materialize
           └──── facts ─────┘   └ interpretations ┘
```

The first three stages are deterministic, cheap, and have one right answer. Interpret is model-driven,
non-deterministic, prompt/model-versioned, and expensive — which is why it's separate and opt-in.

## What it produces

A task is no longer just `{description, messageIndexes}`; it's a set of the session's **interactions**
(its "chapter"), plus the judged outcome:

- **span over interactions** — a task owns the interactions bookmarked to it (an interaction belongs
  to the latest task that started at or before it). The span is *derivable* (`min`/`max` of the owned
  interaction seqs), not stored on the `TaskFact`.
- **`outcome`** — `success` | `failure` | `unclear`.
- **`frustration`** — `none` | `low` | `high`.
- **`signals`** — short evidence tags (e.g. `repeated re-asks`, `no access`).
- **`outcomeReason`** — a one-line rationale.

`TaskFact` (in `src/store/store-contract.ts`) carries these. It is **local-only** — not part of the
pushed wire contract (`@agentdeploymentco/argus-schema`) — so these fields don't affect `argus sync`.

### Interaction → task attribution (#122)

Task membership lives on `resolved_interactions.task_seq`: the `resolved_tasks.seq` of the task an
interaction falls under (NULL = unattributed). It's stamped at materialize via the shared
`assignInteractionTaskSeqs` bookmark. The leaf tables carry **no** task pointer — each `resolved_usage`
row and `resolved_invocation` links to its owning interaction via `interaction_seq`, so tokens / tool
calls / skills are queryable per task by joining `usage`/`invocation → interaction → task`. (Tool
*results* ride on each invocation as `approx_result_tokens`, #130.)

## The two passes

1. **Segment (pass 1).** Runs over the filtered user messages (the existing `TaskCandidateFact`s) to
   produce the task list.
2. **Judge (pass 2).** For each task, feeds the **whole** human↔assistant dialogue projected over the
   task's **interactions** (slice `[first owned interaction's ts, the next task's first interaction's
   ts)`, so boundaries align to interaction openings) to the model and records outcome + frustration +
   signals. The final message alone is a weak signal (users rage-quit; agents over-claim), so pass 2
   reads the entire exchange.

Both passes run for every native source (claude, codex, gemini, cowork) — they judge from the
reconstructed dialogue, not the Claude-only friction signals.

### Dialogue reconstruction (never stored)

Pass 2 needs the actual user/assistant **text**, which the store deliberately doesn't keep. Each
producer reconstructs it on demand from the raw transcript via
`NativeProducer.reconstructDialogue(path)` (`src/indexing/interpret/dialogue.ts` holds the shared `DialogueTurn` type and
time-slicing helper; the per-source extraction lives in each producer's parser, since file format is a
producer concern). The dialogue is an in-memory intermediate, consumed by the passes and discarded —
**no message text is ever written to the store.**

## Configuration (`argus.json`)

Task interpretation is the first **consumer of the shared LLM layer** (`src/llm/`, see
[llm-providers.md](./llm-providers.md)). It owns its prompt and output parsing; which model runs and
how comes from the shared `llm` block in `argus.json`. The opt-in toggle and the consumer-specific
prompt stay under `taskExtraction`:

```jsonc
{
  "llm": {
    "provider": "claude-cli", // off | claude-cli | command | claude-api | openai | gemini | openrouter | hub
    "model": "..."           // optional; the claude-cli provider defaults to haiku
  },
  "taskExtraction": {
    "enabled": false,        // opt-in index-time extraction
    "prompt": "...",         // optional inline prompt override
    "promptFile": "..."      // optional path; precedence over prompt
  }
}
```

For back-compat, the older `taskExtraction.provider` / `taskExtraction.model` / `taskExtraction.command`
keys still work as a per-consumer override of the shared `llm.*` values (deprecated — prefer `llm`).

The **claude-cli provider** invokes `claude -p --no-session-persistence --model haiku -`:
`--no-session-persistence` keeps each interpret call from leaving its own transcript on disk (which
indexing would otherwise pick up as a bogus session), and haiku keeps the per-session calls cheap. A
configured `model` overrides the default. (`--bare` is intentionally not used — in `-p` mode it fails
"Not logged in".)

On macOS, the provider first tries to run that command through `sandbox-exec`. The sandbox denies
filesystem access by default, then allows Claude's executable files, macOS keychain access needed for
the Claude login, Claude's own runtime state, system runtime files, network access, and temp files. If
`sandbox-exec` is unavailable or the sandbox blocks a required Claude operation, Argus logs the
fallback and retries the existing unsandboxed call. Non-macOS runs use the existing unsandboxed call
because `sandbox-exec` is macOS-only.

The **command provider** runs an arbitrary command that reads the prompt on stdin and writes the task
JSON to stdout. The **claude-api/openai/gemini/openrouter providers** call a third-party API directly with a
BYO key (`argus secret set …`); note this transmits the reconstructed dialogue off-machine. See the
privacy note in [llm-providers.md](./llm-providers.md).

## When it runs

- **At index time (opt-in).** With `taskExtraction.enabled`, indexing a session whose transcript
  changed also extracts its tasks. Extraction only runs for *changed* sessions, so enabling it in
  config and re-running `argus index` does not retroactively extract already-indexed sessions.
- **Per session, on demand.** `argus index refresh <id>` re-indexes one session and runs extraction
  (forced on with `--extract-tasks true`, regardless of config). This is the way to try interpretation
  on specific sessions, or to backfill existing ones, without enabling it globally. See
  [single-session reindex](./architecture.md#single-session-reindex).
- **From the web app.** The session detail page's **Refresh** button re-indexes that one session
  (via the same single-session reindex), with task extraction always on. It replaced the older
  on-demand "Extract tasks" button.

## Cost and scope

- It's an LLM call per session (pass 2 is one call per task). The index commands print a per-session
  progress heartbeat so a long run doesn't look stuck.
- Outcome is captured at the **task** level only; it is not rolled up into the session-level
  `clean/interrupted/unknown` proxy (that reconciliation is deliberately deferred).
