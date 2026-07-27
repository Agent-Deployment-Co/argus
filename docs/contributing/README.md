# Writing about Argus

These guides set how we communicate about Argus, everywhere: the documentation,
the web app, the terminal, the README, the repo description, package metadata,
release notes and outreach. Read them before writing, and check a draft against
them before it ships. They apply to people and to AI agents equally.

## The guides

Each owns one question, and they don't repeat each other. When one needs
something another owns, it links.

| Guide | Owns | Read it when |
|---|---|---|
| **[Audience](./audience.md)** | Who we're for | Always. Everything else assumes it. |
| **[Positioning](./positioning.md)** | What we claim | Writing anything that describes Argus |
| **[Voice and tone](./voice-and-tone.md)** | How we sound | Writing any user-facing words |
| **[Terminology](./terminology.md)** | What we call things | Naming anything, anywhere |
| **[Technical writing](./technical-writing.md)** | How a docs page is built | Adding or editing a page in `docs/` |

Audience is upstream of the rest. Positioning settles *what* we say, voice
settles *how* we say it, terminology settles *which words* we use, and technical
writing settles *how a page is put together*. Only the last one is scoped to
`docs/`.

## Common jobs

- **Changing how we describe Argus.** Update
  [Positioning](./positioning.md#canonical-descriptions) first, then work the
  [surface inventory](./positioning.md#surface-inventory) so the surfaces don't
  drift apart.
- **Adding or removing a supported agent.** The code is the source of truth. See
  [the supported list comes from the code](./terminology.md#the-supported-list-comes-from-the-code),
  then work the surface inventory.
- **Writing a CLI message.** [Voice and tone](./voice-and-tone.md#writing-for-the-terminal)
  and [Terminology](./terminology.md).
- **Adding a docs page.** [Technical writing](./technical-writing.md#adding-a-page).
- **Writing outreach copy.** [Positioning](./positioning.md#register-by-surface)
  for what you're allowed to claim and lead with.

## Where this comes from

Argus is a product of The Agent Deployment Company, so these guides follow ADC's
house voice, adapted here to cover everything we publish rather than the docs
alone. They're self-contained, so you don't need anything outside this repo to
write well about Argus.

These pages are kept out of the published site (`srcExclude` in the VitePress
config). They're authoring guidance, not product documentation.
