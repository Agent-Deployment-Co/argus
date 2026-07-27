# Terminology

The words we use for Argus and the things it works with. This is the product
lexicon, and it governs every surface a person sees: the docs, the web app, the
terminal, the README, the repo description, release notes.

Consistency here is worth more than elegance. A reader who meets "session" in the
app, "session" in the docs and "session" in an error message learns the product
once. One that meets three words for the same thing learns it three times.

Two related pages: [Audience](./audience.md) explains who these words are for,
and [Positioning](./positioning.md) covers what we claim, which is a different
question from what we call things.

## Product concepts

Use **session**, **project**, **source** and **store** for the user-facing
concepts. Say **session** for what the reader did with an agent.

**transcript** is the file an agent writes to disk. It's a storage detail, so:

- **Docs pages: never.** Say session. Published pages currently contain no
  instance of the word, and that's the bar.
- **Terminal output: allowed**, because the person running the CLI is acting on
  files and the word is doing real work ("Re-reading all transcripts from
  disk…"). Prefer session where it reads naturally.
- **`docs/internals/`: freely.** Those pages document internals on purpose.

## What Argus does with your data

Two different actions, and they take different verbs. Getting the data in is not
the same as what happens to it afterwards.

**Taking it in: finds and indexes.** "Argus finds and indexes your sessions."

Don't say:

- *reads*, which sounds like Argus only looks, not that it does anything useful
- *loads* or *imports*, which sound like your data moves somewhere, and that
  undercuts the local-first story

Use **include** only for coverage: "Argus includes every agent by default."

**One carve-out on *reads*.** It's the right verb when the subject is what Argus
does to your files rather than what it does for you. "Argus reads files your
agents already wrote to your disk" is precise, and in a privacy context sounding
like Argus only looks is exactly the point. Use it there. Don't use it for a
capability claim, where it undersells.

**What it does afterwards: analyzes.** "Argus analyzes your sessions to find the
work that didn't pay off." That's accurate and plain, and it's the right word for
describing the mechanism.

The one restriction is on where it sits. Analysis is *how* Argus earns the
promise, not the promise itself, so don't open with it. "Argus analyzes your AI
agent usage" makes the reader work out why they should care. See
[the promise](./positioning.md#the-promise).

## Agent names

Write them exactly like this:

| Write | Not |
|---|---|
| Claude Code | Claude-Code, claude code |
| Claude Cowork | Claude CoWork, Claude Co-Work |
| Claude Chat | Claude.ai, Claude Web |
| Codex | OpenAI Codex, Codex CLI |
| ChatGPT Work | Work, ChatGPT for Work, OpenAI Work |
| Gemini CLI | Gemini, Google Gemini |

**Claude Cowork** takes a lowercase "w". That's how Anthropic styles it.

Internal source identifiers and slugs stay lowercase and single-word: `cowork`,
`codex`, `gemini`. Those are code, not copy.

### Codex and ChatGPT Work are two things

They are separate experiences inside ChatGPT, not two names for one product.
OpenAI's own description:

- **Codex** "remains dedicated to software development and technical work."
  Writing and debugging code, running tests, working with a repository.
- **ChatGPT Work** is "an agent designed for longer, multi-step work and finished
  deliverables." Researching a topic, analyzing information, creating a document,
  spreadsheet, presentation or report.

Name them as two supported agents, not as one with a slash. Writing
"Codex / ChatGPT Work" implies they're the same thing, and they aren't.

Argus indexes both through one source because, as best we can tell, they share a
session format and location on disk. The internal slug for that source stays
`codex`, since that's the directory it reads. That's an implementation detail:
in user-facing text, both names appear.

Two caveats worth keeping straight. Only sessions on the machine are visible, so
cloud Work chats on web or mobile aren't indexed. And this rests on our own
observation rather than anything OpenAI documents, so re-check it if coverage
looks wrong.

Naming **ChatGPT Work** explicitly is worth the characters. It is OpenAI's
product for exactly the work Argus is built around, so a reader who lives in Work
learns Argus is for them. See
[which agents a description names](./positioning.md#which-agents-a-description-names).

### The three kinds of agent

The vendors are converging on the same three-tier shape, and OpenAI's split into
Chat, Work and Codex lines up with Anthropic's almost exactly:

| Tier | Anthropic | OpenAI | Google |
|---|---|---|---|
| Knowledge-work agent | Claude Cowork | ChatGPT Work | |
| Chat | Claude Chat | ChatGPT Chat (not indexed) | |
| Coding agent | Claude Code | Codex | Gemini CLI |

This is our working model for reading the landscape, not a taxonomy either vendor
publishes. It's useful anyway, for three reasons.

**It says which tier Argus is centered on.** The knowledge-work row is our
reader. Argus covers the coding row because the same people use those agents too,
not because it's aimed at them. That's what "focuses on business tasks, not code"
means in one line.

**It tells you what order to name agents in.** Knowledge work first, then chat,
then coding, which is the order of how likely our reader is to be using them. A
list that opens with Claude Code reads as a developer tool before the reader
reaches the word "business".

**It shows the gap.** Argus indexes Claude Chat but not ChatGPT Chat, which has
no producer today. Don't imply otherwise, and don't write "ChatGPT" unqualified
in a supported list, because it reads as covering Chat.

### The supported list comes from the code

The set of agents Argus supports is defined in code, never in prose: the
`AgentSource` type in `src/types.ts` and the producer registry in
`src/indexing/parse/producers/`. That's the source of truth. Don't describe a
source the code doesn't have, and don't drop one it does.

Every surface that lists agents has to match it, not just the published
[Supported agents](/supported-agents) page. The repo description and topics, the
README, package metadata and social cards all name agents, and they drift apart
easily. When a producer is added or removed, work through the
[surface inventory](./positioning.md#surface-inventory) in the same change.

## Commands

`serve`, `index`, `sync`, `run`. **`sync` is the upload.** It was formerly
`push`, so don't call it "push" anywhere a user can see.

## Words that stay in the code

Keep internal vocabulary off every user-facing surface: producer, reconcile,
materialize, fragment, fact row, structural index, layer numbers, table names.

Describe the effect the reader observes instead of the mechanism that produces
it. "Re-reading all transcripts from disk", not "cleared the structural index."

Code comments and internal identifiers stay precise and use this vocabulary
freely. So do the pages in `docs/internals/`, which exist to document it.

## Argus is not the subject

Drop the actor and lead with the verb. "Kept archived sessions", not "Argus kept
archived sessions." This applies to terminal output and UI strings, where the
reader already knows what they're running.

## Adding a term

When you introduce a term the published [Terminology](/terminology) page doesn't
cover, add it there in the same change. That page is for readers. This page is
for us.
