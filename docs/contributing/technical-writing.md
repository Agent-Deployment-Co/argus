# Technical writing

How to build a page in the Argus docs: structure, formatting, links and images.

This is the one guide scoped to `docs/` alone. The others govern every surface.
Before writing a page, you want [Audience](./audience.md) for who reads it,
[Positioning](./positioning.md) for what you can claim,
[Voice and tone](./voice-and-tone.md) for how it should sound, and
[Terminology](./terminology.md) for what to call things.

## Page shape

- **Lead with what it is and when to use it.** The first sentence states the
  subject. No preamble, no "in this guide we will."
- **One page, one job.** If a page is doing two jobs, split it and add both to
  the sidebar.
- **Headings name the subject, not the reader's task.** A short noun phrase, or a
  conventional section name where one exists. "Filters", not "Filtering what you
  see". "Updates", not "Keeping Argus up to date". A reader scanning the outline
  is looking for a thing, so give them the thing. `Install`, `Settings` and
  `License` are fine as they are; the rule is aimed at headings shaped like
  sentences, questions or gerunds, not at every heading containing a verb.
- **Heading case: Title Case for the page, sentence case for sections.** A page's
  H1 and its sidebar or nav label use Title Case ("Quick Start", "Supported
  Agents"). Every heading inside the page (H2 and below) uses sentence case
  ("Filters", "Cost estimates").
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

The guides in `docs/contributing/` are excluded the same way, for the same
reason: they're for us, not for readers.

## Usage model: desktop first

The desktop app is how most readers run Argus: install it, and it keeps your data
current and opens the dashboard for you. Lead with the app. Most pages shouldn't
need a command at all.

The command line is an available option, not the default we write around. Present
it as the alternative, after the app, for the
[more technical end](./audience.md#the-technical-range) of the audience. Don't
make a reader open a terminal to follow a page's main path.

When you do show commands:

- Fence every snippet with its language (` ```bash `, ` ```ts `, ` ```json `).
- Show real, runnable commands. The CLI runs through `npx`
  (`npx @agentdeploymentco/argus serve --open`); use that form.
- One command per idea. When a command has more than a couple of flags, document
  them in a table rather than inline prose.
- Never put real local paths, tokens or data in a snippet. Use `/Users/you` and
  the like.

## Link terms on first use

The reader has light familiarity with the language of agents, not fluency. The
published [Terminology](/terminology) page defines the terms they meet (session,
source, skill, tool, MCP server, token and so on). Don't stop to define a term
inline, and don't talk down by over-explaining. Instead, **link the term to its
Terminology entry the first time it appears on a page**, then use it plainly
after that:

```md
Argus indexes your local [sessions](/terminology#session) and...
```

This lets an unfamiliar reader click through to learn and a familiar reader keep
moving without a definition in their way. When you introduce a term the published
Terminology doesn't cover yet, add it there in the same change.

That page is the reader's glossary. [Terminology](./terminology.md) in this
directory is ours, and covers which words we use in the first place.

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
  referenced relatively (`![...](./images/screenshots/x.webp)`). Generate them
  with the screenshot tool (`bun run screenshot`, or the `screenshot` skill),
  which writes two WebP files per page at 2x display resolution, named
  `{name}@{width}x{height}@2.webp`. The batch of docs screenshots is defined in
  `docs/screenshots.yaml`.
- **Other page images** (diagrams, icons, one-offs) go in `docs/images/`,
  referenced relatively (`![...](./images/x.png)`), so Vite hashes and optimizes
  them.
- **Brand assets**, and anything referenced from `config.ts`: put them in
  `docs/public/` and reference them root-absolute (`/x.svg`).
- Screenshots must use synthesized, fake data, never a real session.
