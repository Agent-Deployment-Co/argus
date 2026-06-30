# Technical writing

How to structure and format the docs in this repo. This pairs with
[Voice and tone](./voice-and-tone.md), which covers how they should sound.

## Who reads these

People evaluating or running Argus: moderately technical, comfortable in a
terminal and with the language of agents, but new to Argus and not reading the
source. Write for that reader. The contributor-depth reference (the indexing
pipeline, session model, store schema, and the like) lives in `docs/internals/`,
which is excluded from the published site; everything published stays at the
user's altitude.

## Page shape

- **Lead with what it is and when to use it.** The first sentence states the
  subject. No preamble, no "in this guide we will."
- **One page, one job.** If a page is doing two jobs, split it and add both to the
  sidebar.
- **Short sections with task-shaped headings.** Sentence case ("Quick start," "What
  the web app shows"), not Title Case. A heading names what the reader wants to do
  or know.
- **Front-load the answer.** Put the command or the conclusion first and the
  caveats after.

## Adding a page

Drop a `.md` in `docs/`, then register it in the `sidebar` array in
`docs/.vitepress/config.ts`. A page that isn't in the sidebar still builds, but
nothing links to it. Reference other pages with a root-absolute link
(`/configuration`), matching the existing pages.

A contributor-only page (architecture or store internals, not for end users) goes
in `docs/internals/` instead. That directory is excluded from the published site,
so don't add it to the sidebar, and link between internal pages with relative
links (`./session-model.md`) since they're read in the repo, not on the site.

## Code and commands

- Fence every snippet with its language (` ```bash `, ` ```ts `, ` ```json `).
- Show real, runnable commands. The published CLI runs through `npx`
  (`npx @agentdeploymentco/argus serve --open`); use that form on user-facing
  pages.
- One command per idea. When a command has more than a couple of flags, document
  them in a table rather than inline prose (see the flag tables in `README.md`).
- Never put real local paths, tokens, or data in a snippet. Use `/Users/you` and
  the like.

## Terminology

Use the product's words, consistently.

- **session, transcript, project, source, store** for the user-facing concepts.
- **Claude Cowork** (lowercase "w"), **Claude Code**, **Codex**, **Gemini** for the
  sources.
- `serve`, `index`, `sync`, `run` for the commands. `sync` is the upload (it was
  formerly `push`); don't call it "push" in docs.
- Keep internal names (producer, reconcile, fragment, fact row) off published
  pages. They're fine in `docs/internals/`, which documents internals on purpose.

## Formatting

- **Tables** for flag and option references, and for any "name / what it does"
  list.
- **Admonitions** for asides the reader can skip: `::: tip`, `::: warning`,
  `::: danger`. Use them sparingly.
- **Bold** for a single key term, never a whole sentence. **Inline code** for
  commands, flags, file names, environment variables, and settings.
- **Link** to a related page instead of repeating its content. Send the reader to
  the source of truth.

## Images and screenshots

- A screenshot that belongs to one page: put it in `docs/images/` and reference it
  relatively (`![...](./images/x.png)`), so Vite hashes and optimizes it.
- Brand assets, and anything referenced from `config.ts`: put them in
  `docs/public/` and reference them root-absolute (`/x.svg`).
- Screenshots must use synthesized, fake data, never a real session.
