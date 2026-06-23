# A mental model for agent sessions

This document defines the vocabulary Argus uses to *reason about* an agent session: what a session
is made of, who produces each part, and how the parts relate. It is a conceptual model, not a schema.
It exists because the code grew up around one word — "message" — that turned out to mean too many
different things, and the ambiguity has cost us (confused parsing, a fragile "dialogue
reconstruction" layer, tasks derived from the wrong inputs). Naming the concepts precisely is what
lets the pipeline, the store, and the UI agree on what they're handling.

**The organizing principle is the human user's experience of the session.** Every concept here exists
to capture what the user *asked for*, what they *experienced* in return, and where the session *cost
them friction* — not to mirror the transcript's internal machinery. When a modeling choice arises, we
describe what the user lived through and treat the raw event shapes as producer-specific detail to be
*interpreted* into that. (The validated quirks of each source — duplicate event streams, role-tag
oddities, loops nested inside one record, response delivered via a tool — are exactly that:
producer-level detail, not model concepts.)

## Two orthogonal axes

There are two independent questions you can ask about any piece of a session, and keeping them
separate is the whole point:

1. **What is it?** — its place in the *structure* of the session (a prompt, a tool invocation, a
   piece of harness-injected context, …). This document defines that axis.
2. **How was it produced?** — whether it is a deterministic **fact** read straight from the
   transcript, or a model-driven **interpretation** derived on top. That axis is the subject of the
   indexing pipeline (`Discover → Parse → Reconcile → Interpret → Materialize`; see
   [architecture.md](./architecture.md)).

The axes are orthogonal: the structural concepts below are *mostly* facts, but a few (notably tasks
and outcome) live on the interpretation side. Where a concept falls is called out explicitly in
[Facts vs. interpretations](#facts-vs-interpretations).

## The core idea: the interaction

The unit we were missing is the **interaction**:

```
interaction  =  prompt  →  agent loop  →  response
```

A human (or another initiator) issues a **prompt**; the agent then runs its **loop** — generating
lower-level activity: thinking, tool invocations, narration — and then emits a **response**: the
answer it hands back to the user. One ask, one turn of the crank, one result.

The **prompt** and the **response** are the two ends the user actually experiences — *what I asked*
and *what I got back* — and both are first-class. A **human-initiated** prompt is the sole carrier of
human intent (not every prompt is — see [`initiator`](#anatomy-of-an-interaction)); the response is
the deliverable the user judges the interaction by. Everything between them is *how* the agent got
there.

The response is defined by its **role in the user's experience**, not by any particular physical
form. It is whatever the user perceives as the answer — usually the agent's closing text, but some
producers deliver it another way (a dedicated "send message to user" tool, or the trailing content of
a larger record). Recovering it from the raw events is the producer's job; the model only insists
that every interaction has a response *slot* — what the user got back — even where a given producer
leaves it empty. (An interaction that is interrupted, incomplete, or errors may have no response — see
[`disposition`](#anatomy-of-an-interaction).)

A **session is an ordered list of interactions.** Nothing more exotic: not a tree, not a flat stream
of messages. (Conversational tools like claude.ai chat can branch — an edited prompt spawns an
alternative response — but we explicitly model only the active path, so a session stays a list. See
[Deliberate exclusions](#deliberate-exclusions).)

This single abstraction does a lot of work:

- It separates **what was asked** (the prompt — usually the human's) from **everything the machine
  did in response** (the loop). The role tag on a raw record (`user` / `assistant`) stops being
  load-bearing — *position in the interaction* carries the meaning instead.
- The **dialogue** — the thing we judge tasks against — is no longer something to "reconstruct" by
  filtering messages. It simply *is* the prompts and responses across a session's interactions (with
  the agent's mid-loop narration as supporting detail). It falls out of the structure.

### Anatomy of an interaction

An interaction has:

- **`prompt`** — the text that opens the interaction, authored by its **`initiator`** (below). It is
  *only* the opening text itself: anything the harness bundled alongside it (file attachments,
  reminders) is an [injection](#the-harness-stream), not part of the prompt. The initiator is usually
  the human — in which case the prompt carries human intent — but not always.
- a **loop** — the agent's work between the prompt and the response (see [Inside the
  loop](#inside-the-loop)): thinking, tool invocations, and **narration** (the agent's running
  commentary as it works — "Let me check the config…").
- **`response`** — what the user gets back as the answer when the loop is done: the *product* of the
  interaction, as distinct from the narration along the way (which is *process*). Its physical form
  is producer-specific (closing text, a message tool, the tail of a record); the model cares only
  that it captures what the user experienced as the result. It is the primary signal, alongside the
  prompt, for judging a task's outcome, and the part the UI should surface most prominently. A
  `completed` interaction has one; an `interrupted` or `incomplete` one may not.
- **`initiator`** — who authored the opening prompt. It is one of the
  [actors](#the-four-actors): usually the **human**, but the **harness** can open an interaction
  (a scheduled / `/loop` run, or a resumed *continuation*), and, for a subagent's own session, the
  **agent** that delegated it. Only **human-initiated** prompts carry intent — which is why downstream
  layers (task interpretation) filter on the initiator, and why an agent-authored subagent prompt is
  never mistaken for a human task ([#100](#how-this-informs-the-work)).
- **`disposition`** — how the loop ended (this is the *interaction* disposition; a tool invocation
  has its own — see [Tool invocations](#tool-invocations)):
  - `completed` — the agent handed a response back.
  - `interrupted` — the human took control back mid-loop. We *know* a human stepped in; this is a
    [friction signal](#steering-and-friction).
  - `incomplete` — the loop stopped without a response and we *cannot* attribute it to a human
    interrupt (abandoned, killed, lost). Distinct from `interrupted` precisely because the cause is
    unknown.
  - `error` — the loop failed.

  The interaction's disposition is a mechanical property of the loop — a fact — distinct from a
  *task's* outcome (did the human get what they wanted), which is an interpretation. See [Facts vs.
  interpretations](#facts-vs-interpretations).
- **`compactionCount`** — how many times the harness compacted context *during* this interaction's
  loop. Usually 0; a very long loop can be compacted more than once. It has no structural effect (it
  does not split the interaction — see [Compaction](#compaction)); it is a signal that the loop ran
  long enough to lose context, useful for explaining degraded behavior.

## Inside the loop

The loop is everything between the opening prompt and the response. Its contents are **produced by
the agent** (plus context fed in by the harness — see the next section). There is no human content
*inside* a loop: a human touches a session only at an interaction's edges (the prompt that opens it,
an interrupt that closes it) or *through a tool* (see permissions and AskUserQuestion below) — never
as free-floating content mid-loop.

Loop contents:

- **thinking** — the agent's reasoning (Claude `thinking` / `redacted_thinking` blocks). Not shown to
  the user as dialogue.
- **narration** — the agent's user-facing prose *during* the loop: progress and commentary as it
  works ("Let me check the config…" → tool call → "Found it, now…"). Narration is *process*; it is
  distinct from the **response** — the closing answer, which lives at the interaction level (above),
  not inside the loop. The user sees both, but judges the result by the response.
- **tool invocations** — see below.

### Tool invocations

A **tool invocation** is a **call + its response** treated as one unit (the call requests work; the
response is the result fed back). This pairing is first-class — not two loosely correlated records.

- **Subagents are tool invocations.** Spawning a subagent is a tool call whose response is the
  subagent's final output. This is *altitude-relative*: at the parent's level a subagent run is one
  tool invocation inside the loop; viewed on its own, that same subagent transcript is a session with
  its own interaction(s). The model is self-similar — a tool invocation whose tool happens to be an
  agent contains a session one level down.
- **Permissions attach to the invocation** (full treatment in [Permissions](#permissions)). The
  allow / deny / auto-approve outcome rides on the tool invocation; a denial does not end the
  interaction — the agent receives the rejection and typically continues.
- **A tool invocation has its own disposition** — it `completed`, or it was `interrupted` (the call
  was made but its response never arrived — the human cut the loop, or it was killed mid-tool). We do
  not otherwise model an invocation's internals here; the model captures the call, its response when
  there is one, its permission outcome, and how it resolved.
- **AskUserQuestion is a tool.** Mid-loop human engagement (answering a question the agent posed) is
  tool-mediated, so it is captured as a tool invocation rather than as free-floating human input in
  the loop.
- **MCP calls and skills are facets of a tool invocation, not new primitives.** An MCP call is just a
  tool invocation whose tool lives on an MCP server — the `mcp__server__tool` identity is metadata on
  the invocation. A skill, when the agent runs it, is a `Skill` tool invocation carrying the skill
  name. The `byTool` / `byMcp` / `bySkill` breakdowns all derive from invocations plus these facets.

#### Skills: a fact at the point of invocation, an interpretation thereafter

A skill needs a caveat the others don't. **Invoking** a skill is a clean fact — a `Skill` tool
invocation (or, when a user types `/foo`, a [prompt](#commands)). But a skill then drops instructions
into context that *guide subsequent behavior with no "skill ended" marker anywhere in the
transcript.* So a skill's **scope** — which interactions and work it actually governed — is an
interpretation, and usually a weak one. How far it can be bounded depends on how the skill manifests:

- **Bounded to one interaction** — a `/foo` prompt whose whole interaction *is* "do foo." That
  interaction is the skill's; the next one already leaks.
- **Bounded to a sub-unit** — if the skill delegates its work to a subagent, that subagent's whole
  session is cleanly the skill's (a self-contained tool invocation). The clean case — but skills
  usually run inline, so it's the exception.
- **Unbounded** — a mid-loop `Skill` call that returns instructions into the main context: the rest
  of that loop is plausibly skill-guided, but the influence bleeds into later interactions with
  nothing marking the end. The common case.

So: attribute the skill **invocation** as a fact; treat its **span** as best-effort, never ground
truth. Don't sum cost "by skill" as if it were exact, and don't assume a skill aligns with a
[task](#tasks) — a skill can span several tasks, be a slice of one, or cleanly govern none. Skill
scope and task span are independent.

## The four actors

Every part of a session traces to exactly one of four **actors**. This table *is* the model — it says
who can author what, and where it lands. (An *actor* is the **author** of a part of a session. Don't
confuse it with a *producer* — the per-source reader in the indexing pipeline that turns one tool's
files into events; see [architecture.md](./architecture.md). "Producer-specific," used elsewhere in
this doc, refers to that reader, not to an actor.)

| Actor | What it makes | Where it lands |
|----------|---------------|----------------|
| **human** | intent-bearing prompts; interrupts; permission decisions; commands | opens an interaction; closes it (`interrupted`); a tool-invocation disposition; a [Command](#commands) |
| **agent** | thinking, narration, the response, tool calls (incl. the prompt that opens a subagent's own session) | inside the loop; the response closes the interaction |
| **tool** | tool responses (including subagents and AskUserQuestion) | the response half of a tool invocation |
| **harness** | injections; compaction; permission policy; scheduled / continuation prompts; and a long tail of other harness events | session-level, opens an interaction, or positioned within the timeline (see below) |

The crucial consequence: **human intent lives only in human-initiated prompts.** A subagent's
instruction is produced by the *agent* (a tool call) and consumed by a *tool* — it is never a human
prompt, so it can never be mistaken for one. A `<system-reminder>` is produced by the *harness* as an
injection — never a prompt. The "user" role tag, which all three of these share in the raw transcript,
stops being a source of confusion once authorship is named. (The harness and the agent can also author
the *opening* prompt of an interaction — scheduled runs, subagent sessions — but those prompts carry
no human intent, which is the whole point of tracking the [`initiator`](#anatomy-of-an-interaction).)

## The harness stream

The harness is free to emit events at **any** point in the flow. These are not authored by the human
or the agent, and they must never be conflated with a prompt or a response.

We deliberately do **not** taxonomize everything the harness emits. Real harnesses produce a long,
evolving tail of operational and metadata events — lifecycle markers, token metering, status pings,
titles, git/worktree state, hook bookkeeping. The model treats these collectively as **harness
events** and does not enumerate them: a producer surfaces whichever ones it has, and most are simply
not part of the session's structure or the user's experience. What the model *does* name are the four
things in the harness's domain that change how we read the session or what the user lived through —
**injections**, **compaction**, **commands**, and **permissions**. (Not all four are harness-*authored*:
a command comes from the human, a permission decision often does too — but all four live around the
harness.) Each is below; everything else is just a harness event.

### Injections

Harness-authored context fed into the agent's view. By position:

- **Session-level (standing)** — the system prompt, project instructions (`CLAUDE.md`), environment
  context: the configuration the agent runs under. Logically session-wide — though some producers
  (SDK / agent-mode runners that treat each interaction as its own run) physically re-emit this
  config at the opening of *every* interaction. Either way it is configuration, not a prompt.
- **At an interaction's opening** — context bundled *with* a prompt: `<system-reminder>`s,
  auto-attached file contents, `@`-mention expansions. These ride in alongside the prompt but **are
  not the prompt** — they attach to the interaction's opening as injections. (This is the line that
  protects task interpretation: what's fed to extraction is the prompt's own text, not the bundled
  context.)
- **Inside the loop** — context injected during the loop, typically after a tool invocation: hook
  outputs (PreToolUse / PostToolUse feedback), todo reminders, action-triggered reminders.

Injections are mostly *not* part of the dialogue, but they are named rather than silently dropped:
they cost input tokens (relevant to usage accounting) and they explain agent behavior (why did the
agent do X? — a hook told it to).

### Compaction

When context fills, the harness **compacts** prior history into a summary. Compaction is a harness
event with a position in the timeline; it is **not** an interaction boundary.

Crucially, a compaction that happens mid-loop does **not** split an interaction. The agent keeps
pursuing the same prompt's goal and eventually hands back — one ask, one result, **one
interaction**, with a compaction event sitting inside its loop. Contrast with an *interrupt*: both
"disrupt" the loop, but an interrupt is human and intent-level (it ends the flow and closes the
interaction), whereas a compaction is harness-driven and mechanical (it rewrites context underneath
an ongoing loop and is transparent to intent). The interaction records the fact via
`compactionCount`, not by fragmenting.

> The deeper principle: **a harness event never defines an interaction boundary — a prompt does.**
> A prompt opens an interaction; a response (or an interrupt) closes it. The operational events the
> harness emits simply fall *somewhere* relative to that structure: between two interactions, or inside
> one's loop. (The harness *can* author an opening prompt — a scheduled or resumed run — but then it is
> acting as that interaction's [initiator](#anatomy-of-an-interaction), not emitting a boundary-less
> event.)

### Commands

The leading slash is just input shorthand — it does **not** by itself make something a command. What
matters is *what the entry resolves to*:

- **Resolves to a request** → it is a **prompt** and opens a task-bearing interaction normally. A
  user-invoked skill (`/foo`), `/code-review`, or any custom command whose body is "go do X" expands
  into the human's request; the slash is just a macro for prompt text.
- **Resolves to a harness control action** → it is a **command**: `/compact`, `/clear`, `/config`,
  `/model`. A command is human-initiated but is *not* a task-bearing interaction — it carries no
  goal-bearing prompt and produces no response; it just tells the harness to do something.

So `/foo` (a skill you defined) is a *prompt*, not a command, even though both are typed with a slash.
Whether commands are persisted to the store at all is left open; the point here is to keep them from
being mistaken for prompts.

### Permissions

Permissions get named (rather than lumped into the harness-event tail) because they are a direct
source of **user friction**: they are where the session stops and demands the human's attention. Two
distinct things:

- **Permission policy** — a *standing* setting (ask / auto-approve / bypass / plan), configured by
  the human and carried by the harness. It governs whether a given tool call even prompts. Some
  producers re-state it per interaction.
- **Permission decision** — what actually happened for a specific tool invocation: the human
  **approved** it, the human **denied** it, or it was **auto-approved** under policy. Denials can also
  be **policy-initiated** (a sandbox or rule rejects the call) with no human in the loop.

The two signals worth capturing: **approvals the human had to grant** (repeated approvals are
friction — the user keeps getting pulled in to click "allow"), and **denials** (human- or
policy-initiated — each marks a blocked path). The decision is a property of the tool invocation; the
policy is harness configuration.

## Steering and friction

Because the model is oriented to the user's experience, the points where the human had to **intervene**
are first-class signals, not noise. Two recur:

- **Steering** — the human interrupts a running loop to redirect the agent. Producers record this
  differently (some close the turn and open a new one; some resume the *same* turn after the
  redirect), and the model does not depend on which: the fact it must preserve is the same — **the
  human had to step in and correct course.** That is friction however the interaction boundaries
  fall. (The mechanical record of it is the `interrupted` [disposition](#anatomy-of-an-interaction);
  the *meaning* is steering.)
- **Permission friction** — the human is repeatedly pulled in to approve tool calls, or hits denials
  (see [Permissions](#permissions)).

These are the raw material for the per-task **frustration** / outcome judgment ([Tasks](#tasks)) and
are what the earlier session-level friction experiments (#37) were reaching for. The model's job is to
make sure the signal *survives* into the structure — that it isn't smoothed away when a producer's raw
events are interpreted into interactions.

## Tasks

A **task** is a *set of related interactions* within a session — the "chapters" of [#88](https://github.com/Agent-Deployment-Co/argus/issues/88).
Where an interaction is one ask-and-result, a task is the larger thing the human was trying to
accomplish, which may span several interactions (ask, clarify, refine, fix).

Because a session is an ordered list of interactions, a task is naturally a span (or set) over
**interactions** — not over raw messages or message-sequence numbers. The facts that happened in
service of a task (the tool invocations, skills, and subagents inside its interactions' loops) are
the work attributed to it.

A task carries an **outcome** (`success` / `failure` / `unclear`) and a sense of how much friction
the human hit. These are *interpretations* (see below), judged from the task's dialogue — which, per
the core idea, is just the prompts and responses of the task's interactions (with narration as
supporting detail). There is nothing to "reconstruct": the dialogue is a projection of the structure.

## Facts vs. interpretations

Mapping the structural concepts onto the production axis:

**Facts** (deterministic, read from the transcript; produced by Parse/Reconcile):

- interactions and their boundaries
- `initiator`, interaction `disposition`, `compactionCount`
- prompts, responses, narration, thinking
- tool invocations (call + response), with their permission decision and disposition
- injections, compaction events, commands, permission policy/decisions, and other harness events
- steering / permission friction signals
- the human↔agent dialogue (a projection of prompts + responses, with narration as detail)

**Interpretations** (model-driven, opt-in; produced by Interpret):

- tasks — *which* interactions group together into a chapter
- per-task `outcome` and frustration

The line to hold: **disposition is a fact, outcome is an interpretation.** "Did the loop hand back?"
is mechanical; "did the human get what they wanted?" is a judgment. They have been blurred before
(the session-level `clean/interrupted/unknown` proxy); this model keeps them apart.

## Vocabulary

| Term | Meaning |
|------|---------|
| **event** | A raw record on disk (a line of `.jsonl`). The bytes. This is the *only* surviving use of the old "message" concept — it is the API/transcript object, nothing more. |
| **interaction** | `prompt → agent loop → response`. The atomic unit of a session: one prompt, its loop, and the response. |
| **session** | An ordered list of interactions. |
| **prompt** | The text that opens an interaction, authored by its initiator (usually the human). Only the opening text itself — bundled context is an injection. Carries human intent only when human-initiated. |
| **response** | What the user gets back as the answer, closing an interaction — the product they experience and judge by. Physical form is producer-specific. |
| **narration** | The agent's user-facing prose *during* the loop (progress / commentary); process, not product. |
| **loop** | The agent's activity between an interaction's prompt and its response. |
| **thinking** | The agent's reasoning blocks. |
| **tool invocation** | A tool call paired with its response. Subagents are tool invocations. Can be interrupted (no response) and carries a permission outcome. MCP calls and skill runs are facets of it. |
| **skill** | A packaged capability the agent runs (a `Skill` tool invocation) or the human invokes (`/foo`, a prompt). Its *invocation* is a fact; its *scope* over later interactions is an interpretation, often indeterminate. |
| **initiator** | Who authored the opening prompt — an actor: human, agent (a subagent's own session), or harness (a scheduled run or resumed continuation). Only human-initiated prompts carry intent. |
| **interaction disposition** | How an interaction's loop ended: `completed`, `interrupted` (known human interrupt — a friction signal), `incomplete` (stopped with no response, cause unknown), or `error`. A tool invocation has its own disposition too. |
| **injection** | Harness-authored context fed to the agent; never a prompt or a response. |
| **compaction** | A harness event that summarizes prior context; recorded as a count, never a boundary. |
| **command** | A slash entry that resolves to a harness control action (`/compact`, `/clear`, `/config`); not a task-bearing interaction. A slash entry that expands into a request (e.g. a `/foo` skill) is a *prompt*, not a command. |
| **permission** | A *policy* (standing ask/auto/bypass setting) and a per-invocation *decision* (approved / denied / auto-approved; denials may be human- or policy-initiated). A primary friction signal. |
| **harness event** | Any other operational/metadata event the harness emits (lifecycle, metering, status, titles, git state, …); not enumerated, mostly outside session structure. |
| **task** | A set of related interactions; a session "chapter," with an interpreted outcome. |
| **actor** | The author of a part of a session: human, agent, tool, or harness. Distinct from a *producer* (the per-source reader in the indexing pipeline; see [architecture.md](./architecture.md)). |

> **"Message" is retired** as a unit of meaning. When we mean the bytes, we say *event*; when we mean
> a part of the conversation, we say *prompt*, *response*, *narration*, *tool invocation*, *thinking*,
> or *injection*. "Message" survives only as a synonym for the raw API object when talking to the API
> itself.

## How this informs the work

This model is the shared frame for several in-flight efforts:

- **Indexing stages ([#98](https://github.com/Agent-Deployment-Co/argus/issues/98)).** The facts/interpretations
  seam is the production axis; this document is the structural axis. Parse/Reconcile should produce
  *interactions* and *tool invocations* as facts, rather than stopping at flat events and forcing
  later stages to re-derive structure from role tags.
- **Tasks as chapters ([#88](https://github.com/Agent-Deployment-Co/argus/issues/88)).** A task is a set of
  interactions; its chapter span is over interactions; its dialogue is the prompts + responses of
  those interactions (no reconstruction layer).
- **Task-centric UI ([#90](https://github.com/Agent-Deployment-Co/argus/issues/90)).** The layout falls out of
  the model: render the session as its prompt→response pairs (the readable dialogue); expand an
  interaction to reveal its loop (narration, tool invocations, subagents, thinking); group
  interactions into task chapters.
- **claude.ai chat source ([#94](https://github.com/Agent-Deployment-Co/argus/issues/94)).** Chat is the
  degenerate case — interactions with a thin or empty loop. It validates the model by fitting the
  simplest case, and it is why branching is named-but-excluded rather than ignored.
- **Phantom subagent tasks ([#100](https://github.com/Agent-Deployment-Co/argus/issues/100)).** One concrete
  instance of the "message" confusion: subagent prompts (agent-produced tool calls) were treated as
  human prompts. Under this model that is structurally impossible — intent lives only in
  human-initiated prompts, and a subagent's own session is *agent*-initiated.

## Deliberate exclusions

These are named so they are not rediscovered as surprises:

- **Branching.** Conversational tools allow alternative responses (edited prompts, regenerations),
  which would make a session a tree. We model only the **active path**, so a session remains an
  ordered list. Branching is a known future extension, not an oversight.
- **Session-level outcome rollup.** Outcome is judged per *task*. Rolling per-task outcomes up to a
  single session verdict is deliberately out of scope here.
</content>
