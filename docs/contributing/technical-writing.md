# Technical writing

How to structure and format the docs in this repo. This pairs with
[Voice and tone](./voice-and-tone.md), which covers how they should sound.

## Who reads these

People who use AI agents to get go-to-market work done, not to write software.
Think sales, marketing, revops, and AI-ops: a rep researching accounts with
Claude or Codex, a marketer drafting content, a revops practitioner building
reports and small apps, an AI-ops leader watching agent use across a team. They
span a wide technical range, from people who never open a terminal to people who
are fairly technical but still aren't developers. Assume light familiarity with
the language of agents, not fluency, and never assume they've read the source.

Two reading modes to write for:

- **Single-player.** One person understanding their own agent use and getting more
  out of it. This is most readers.
- **Multi-player.** An ops or AI-ops reader looking across many people's use and
  building shared skills, connectors, and other infrastructure for them. This is
  the Argus Hub audience.

Write for that range. **Never talk down.** Explain a term once and trust the
reader to keep up. The contributor-depth reference (the indexing pipeline, session
model, store schema, and the like) lives in `docs/internals/`, which is excluded
from the published site; everything published stays at the user's altitude.

## Page shape

- **Lead with what it is and when to use it.** The first sentence states the
  subject. No preamble, no "in this guide we will."
- **One page, one job.** If a page is doing two jobs, split it and add both to the
  sidebar.
- **Short sections with task-shaped headings.** A heading names what the reader
  wants to do or know.
- **Heading case: Title Case for the page, sentence case for sections.** A page's
  H1 and its sidebar/nav label use Title Case ("Quick Start", "Supported Agents").
  Every heading inside the page (H2 and below) uses sentence case ("Get started",
  "What the dashboard shows").
- **Front-load the answer.** Put the command or the conclusion first and the
  caveats after.

## Adding a page

Drop a `.md` in `docs/`, then register it in the `sidebar` array in
`docs/.vitepress/config.ts`. A page that isn't in the sidebar still builds, but
nothing links to it. Reference other pages with a root-absolute link
(`/download`), matching the existing pages.

A contributor-only page (architecture or store internals, not for end users) goes
in `docs/internals/` instead. That directory is excluded from the published site,
so don't add it to the sidebar, and link between internal pages with relative
links (`./session-model.md`) since they're read in the repo, not on the site.

## Usage model: desktop first

The desktop app is the way most readers run Argus: install it, and it keeps your
data current and opens the dashboard for you. Lead with the app. Most pages
shouldn't need a command at all.

The command line is an available option for readers who want it, not the default
we write around. Present it as the alternative, after the app, for the
more-technical end of the audience. Don't make a reader open a terminal to follow
a page's main path.

When you do show commands:

- Fence every snippet with its language (` ```bash `, ` ```ts `, ` ```json `).
- Show real, runnable commands. The CLI runs through `npx`
  (`npx @agentdeploymentco/argus serve --open`); use that form.
- One command per idea. When a command has more than a couple of flags, document
  them in a table rather than inline prose (see the flag tables in `README.md`).
- Never put real local paths, tokens, or data in a snippet. Use `/Users/you` and
  the like.

## Terminology

Use the product's words, consistently.

- **session, project, source, store** for the user-facing concepts. Say
  **session** for what the reader did with an agent. **transcript** is a storage
  detail nobody outside the code cares about, so keep it to `docs/internals/`.
- For what Argus does with that data, say **finds and indexes** ("Argus finds and
  indexes your sessions"): it discovers your sessions and builds a local index.
  Don't say *reads* (it sounds like Argus only looks, not that it does anything
  useful), and don't say *loads* or *imports* (they sound like your data moves
  somewhere, which undercuts the local-first story). Use **include** only for
  coverage ("Argus includes every agent by default").
- **Claude Code**, **Claude Cowork** (lowercase "w"), **Claude Chat**, **Codex**,
  and **Gemini CLI** for the agents.
- `serve`, `index`, `sync`, `run` for the commands. `sync` is the upload (it was
  formerly `push`); don't call it "push" in docs.
- Keep internal names (producer, reconcile, fragment, fact row) off published
  pages. They're fine in `docs/internals/`, which documents internals on purpose.

### Supported agents come from the code

The list of agents Argus supports is defined in code, not prose: the `AgentSource`
type in `src/types.ts` and the producer registry in
`src/indexing/parse/producers/`. That's the source of truth. The published
[Supported agents](/supported-agents) page must match it exactly, including the
user-facing names above. When a producer is added or removed, update that page in
the same change. Don't describe a source the code doesn't have, and don't drop one
it does.

### Link terms on first use

The reader has light familiarity with the language of agents, not fluency. The
[Glossary](/glossary) defines the terms they meet (session, transcript, source,
skill, tool, MCP server, token, and so on). Don't stop to define a term inline,
and don't talk down by over-explaining. Instead, **link the term to its glossary
entry the first time it appears on a page**, then use it plainly after that:

```md
Argus indexes your local [sessions](/glossary#session) and...
```

This lets an unfamiliar reader click through to learn and a familiar reader keep
moving without a definition in their way. When you introduce a term the glossary
doesn't cover yet, add it to the glossary in the same change.

## Formatting

- **Tables** for flag and option references, and for any "name / what it does"
  list.
- **Admonitions** for asides the reader can skip: `::: tip`, `::: warning`,
  `::: danger`. Use them sparingly.
- **Bold** for a single key term, never a whole sentence. **Inline code** for
  commands, flags, file names, environment variables and settings.
- **Link** to a related page instead of repeating its content. Send the reader to
  the source of truth.
- **No Oxford comma.** Skip the comma before the final "and" or "or" in a simple
  list ("skills, tools and MCP servers"). Add it back only when a list is complex
  enough that leaving it out is ambiguous, for example when the items themselves
  contain "and" or commas.

## Images and screenshots

- **Product screenshots** of the Argus web app go in `docs/images/screenshots/`,
  referenced relatively (`![...](./images/screenshots/x.webp)`). Generate them with
  the screenshot tool (`bun run screenshot`, or the `screenshot` skill), which
  writes two WebP files per page at 2x display resolution, named
  `{name}@{width}x{height}@2.webp`. The batch of docs screenshots is defined in
  `docs/screenshots.yaml`.
- **Other page images** (diagrams, icons, one-offs) go in `docs/images/`,
  referenced relatively (`![...](./images/x.png)`), so Vite hashes and optimizes them.
- **Brand assets**, and anything referenced from `config.ts`: put them in
  `docs/public/` and reference them root-absolute (`/x.svg`).
- Screenshots must use synthesized, fake data, never a real session.
