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

A task is no longer just `{description, messageIndexes}`; it's a **chapter** of the session:

- **`chapter`** — an inclusive span over the session's reconciled messages (`{startSeq, endSeq}`).
  Chapters bookmark the timeline: a message belongs to the latest task that started at or before it.
- **`outcome`** — `success` | `failure` | `unclear`.
- **`frustration`** — `none` | `low` | `high`.
- **`signals`** — short evidence tags (e.g. `repeated re-asks`, `no access`).
- **`outcomeReason`** — a one-line rationale.

`TaskFact` (in `src/store-contract.ts`) carries these. It is **local-only** — not part of the pushed
wire contract (`@agentdeploymentco/argus-schema`) — so these fields don't affect `argus sync`.

### Fact → task attribution

`resolved_messages` has a `task_seq` column (schema v8): the `resolved_tasks.seq` of the chapter a
message falls under (NULL = unattributed). It's stamped at materialize from the chapter spans, so the
messages — and the tool calls / skills inside them — are queryable per task. (Tool *results* are still
a session-level aggregate; attributing them per task is future work.)

## The two passes

1. **Segment (pass 1).** Runs over the filtered user messages (the existing `TaskCandidateFact`s) to
   produce the task list, then computes each task's chapter span by timestamp bookmark.
2. **Judge (pass 2).** For each chapter, feeds the **whole** human↔assistant dialogue for that task to
   the model and records outcome + frustration + signals. The final message alone is a weak signal
   (users rage-quit; agents over-claim), so pass 2 reads the entire exchange.

Both passes run for every native source (claude, codex, gemini, cowork) — they judge from the
reconstructed dialogue, not the Claude-only friction signals.

### Dialogue reconstruction (never stored)

Pass 2 needs the actual user/assistant **text**, which the store deliberately doesn't keep. Each
producer reconstructs it on demand from the raw transcript via
`NativeProducer.reconstructDialogue(path)` (`src/dialogue.ts` holds the shared `DialogueTurn` type and
time-slicing helper; the per-source extraction lives in each producer's parser, since file format is a
producer concern). The dialogue is an in-memory intermediate, consumed by the passes and discarded —
**no message text is ever written to the store.**

## Configuration (`argus.json`)

Task interpretation is configured through the `argus.json` settings store (see
[configuration.md](./configuration.md)). The relevant block:

```jsonc
{
  "taskExtraction": {
    "enabled": false,        // opt-in index-time extraction
    "provider": "claude",    // "off" | "claude" | "command"
    "model": "...",          // optional; the claude provider defaults to haiku
    "prompt": "...",         // optional inline prompt override
    "promptFile": "...",     // optional path; precedence over prompt
    "command": "..."         // for the "command" provider
  }
}
```

The **claude provider** invokes `claude -p --no-session-persistence --model haiku -`:
`--no-session-persistence` keeps each interpret call from leaving its own transcript on disk (which
indexing would otherwise pick up as a bogus session), and haiku keeps the per-session calls cheap. A
configured `model` overrides the default. (`--bare` is intentionally not used — in `-p` mode it fails
"Not logged in".)

The **command provider** runs an arbitrary command that reads the prompt on stdin and writes the task
JSON to stdout.

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
