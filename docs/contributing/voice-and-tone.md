# Voice and tone

How Argus sounds. This adapts ADC's house voice, and it governs every surface a
person reads: the docs, the web app, the terminal, the README, the repo
description, release notes, outreach. When in doubt, favor clarity over flourish.

[Positioning](./positioning.md) covers what we claim and which register each
surface uses. [Audience](./audience.md) covers who we're talking to.

## The dial

The house voice runs from opinionated long-form (posts, the newsletter) to plain
reference (internal docs). Argus sits near the plain end: clear, confident,
concise. Say what the thing is, how it works and when to use it. Skip the warm-up.
Write for someone who needs to act, not someone who needs to be sold.

Keep the core voice, and ease off the long-form signature:

- Don't open with a scene, an anecdote or a hook. Lead with the subject.
- Go light on analogies. Use one only when it does real explanatory work.
- No footnote asides, no self-deprecating bits, no winking. Those belong in
  posts.

## Core principles

These always hold, on every surface.

- **Every word earns its place.** Use the fewest, clearest words that say exactly
  what you mean. If a sentence can be cut, cut it. If a paragraph can be a
  sentence, make it one.
- **Say what it is.** Direct statements over hedged or inflated ones. If you
  genuinely don't know, say so and say why.
- **Active voice.** Say who or what does the thing. "Argus indexes your sessions
  as they change", not "sessions are indexed as they change".
- **Connect with words, not punctuation.** Let "but", "so", "while" and "because"
  carry the logic instead of a colon or a dash.
- **Be human, in moderation.** Contractions are good. A plain, friendly register
  beats a stiff one. Argus doesn't need a joke to land.
- **Plain words.** File, folder, session, project, source. Never the words the
  code uses. See [Terminology](./terminology.md).

## Not a sales pitch

**This section is scoped to reference documentation**, meaning everything
published under `docs/`, plus terminal output and UI strings. The README, repo
description, social cards and outreach may lead with the promise instead, and
[Positioning](./positioning.md#register-by-surface) says how. Everything else on
this page applies to both registers.

In the docs, Argus is an open source tool, not a product we're selling. Write
like a maintainer showing a peer how it works, not like a B2B marketing site
pitching a buyer. The reader should feel informed, never courted.

- No hero taglines, no feature-benefit pitches, no calls to action ("get started
  today", "supercharge your workflow").
- No vague or aspirational social proof: "trusted by teams", "join thousands of
  users", "enterprise-grade". Real, verifiable proof is fine when it exists, but
  none of that exists today, so don't write it yet. Never invent or inflate it.
- Don't sell the outcome. State what Argus does and what the reader sees, and let
  them decide if it's useful. A plain capability beats a promised benefit.
- Confident, not promotional. "Argus finds and indexes your sessions locally" is
  confident. "Argus gives you powerful, effortless visibility" is a pitch.

Even where the promise is allowed, this instinct still governs the sentences
underneath it. Leading with "find and fix wasted agent work" doesn't license a
paragraph of adjectives after it.

## Writing for the terminal

Anything printed to the terminal (CLI output, help text, error messages) is read
by the more technical end of the [audience](./audience.md#the-technical-range):
comfortable in a terminal, fluent in the language of agents, and still someone
who has never read the code.

- **Plain language.** Words the user already knows: file, directory, session,
  project. The one exception is *transcript*, which is allowed here because the
  reader is acting on files. See [Terminology](./terminology.md#product-concepts).
- **Don't name code internals.** Describe the effect the user observes, not the
  mechanism. "Re-reading all transcripts from disk", not "cleared the structural
  index."
- **Active voice.** "Kept archived sessions", not "archived sessions were
  preserved."
- **Don't make Argus the subject.** Drop the actor and lead with the verb. "Kept
  archived sessions", not "Argus kept archived sessions."
- **Never market mid-task.** Someone reading an error message wants the error
  fixed.

## Cut on sight

The tells that make writing read as generic or machine-made. Scan for these
before calling a draft done.

- **Marketing buzzwords:** unlock, supercharge, leverage, empower, streamline,
  seamlessly, world-class. Say what actually happens instead.
- **The rhetorical reframe:** "That's not X, it's Y." Keep the half that does
  real work, cut the setup.
- **Filler emphasis:** "Here's the thing:", "Let's be clear:". Just say the
  thing.
- **Self-certifying honesty:** "honestly", "to be honest", "frankly". Cut the
  qualifier and make the claim.
- **Passive voice.** Say who does what.
- **Over-explaining the value.** State the outcome and trust the reader.
- **Example-stuffing.** An abstract phrase with a list of specifics bolted on to
  prove you were concrete. Trust the description, or give the single sharpest
  example.
- **Sentence-long bolding.** Bold one surgical phrase or a term, never a whole
  sentence.
- **Consultant-speak:** leverage to "use", utilize to "use", pain point to
  "problem". Reach for the plainer word.

## No em-dashes

Don't use em-dashes anywhere in Argus writing. Not as a connector, not as a
parenthetical pair, not as a trailing aside. Use commas or parentheses for an
aside, a colon or a new sentence for a supplement, and a conjunction (or two
sentences) for a connector.

This is a bright line ADC holds because agent-drafted copy reaches for em-dashes
constantly, so it's easier to hold the line than to ration them.

## Before you ship

- [ ] Buzzword or consultant-speak, swap for the plainer word
- [ ] Rhetorical reframe ("not X, it's Y"), keep the real half
- [ ] Filler emphasis or self-certifying honesty, cut it
- [ ] Passive voice, say who does what
- [ ] Over-explaining, state the outcome and stop
- [ ] Code internals on a user-facing surface, describe the observable effect
- [ ] Real paths, names or data, swap for fake fixtures
- [ ] Any em-dash, use a comma, parentheses, colon or conjunction
- [ ] Reads like a sales pitch on a surface that shouldn't, make it a plain
      statement
- [ ] Could this paragraph be a sentence? Could this sentence be cut?
- [ ] Read it aloud: does it sound like a person, or a brochure?
