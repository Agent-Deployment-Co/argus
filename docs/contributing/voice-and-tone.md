# Voice and tone

These rules define how Argus docs sound. They adapt ADC's house voice for technical
documentation, and everything you need is on this page. When in doubt, favor
clarity over flourish.

## The dial for docs

The house voice runs from opinionated long-form (posts, the newsletter) to plain
reference (internal docs). Argus docs sit near the plain end: clear, confident,
concise. Say what the thing is, how it works, and when to use it. Skip the warm-up.
Write for someone who needs to act on the page, not someone who needs to be sold.

Keep the core voice, and ease off the long-form signature:

- Don't open with a scene, an anecdote, or a hook. Lead with what the page covers.
- Go light on analogies. Use one only when it does real explanatory work.
- No footnote asides, no self-deprecating bits, no winking. Those belong in posts.

## Not a sales pitch

Argus is an open source tool, not a product we're selling. Write like a maintainer
showing a peer how it works, not like a B2B marketing site pitching a buyer. The
reader should feel informed, never courted.

- No hero taglines, no feature-benefit pitches, no calls to action ("get started
  today," "supercharge your workflow").
- No vague or aspirational social proof: "trusted by teams," "join thousands of
  users," "enterprise-grade." Real, verifiable proof is fine when it exists (a
  genuine "used by" list, an actual GitHub star count), but none of that exists
  today, so don't write it yet. Never invent or inflate it.
- Don't sell the outcome. State what Argus does and what the reader sees, and let
  them decide if it's useful. A plain capability beats a promised benefit.
- Confident, not promotional. "Argus reads your transcripts locally" is confident.
  "Argus gives you powerful, effortless visibility" is a pitch.

This is the same instinct as the buzzword list under "Cut on sight," applied to the
whole register, not just word choice.

## Core principles

These always hold.

- **Every word earns its place.** Use the fewest, clearest words that say exactly
  what you mean. If a sentence can be cut, cut it. If a paragraph can be a
  sentence, make it one.
- **Say what it is.** Direct statements over hedged or inflated ones. If you
  genuinely don't know, say so and say why.
- **Active voice.** Say who or what does the thing. "The producer reads the
  transcript," not "the transcript is read."
- **Connect with words, not punctuation.** Let "but," "so," "while," and "because"
  carry the logic instead of a colon or a dash.
- **Be human, in moderation.** Contractions are good. A plain, friendly register
  beats a stiff one. Docs just don't need a joke to land.

## Argus specifics

These come from the repo's own rules (`CLAUDE.md`, "User-facing messages") and
apply to docs as much as to terminal output.

- **Plain language for a go-to-market reader.** Argus is for people using AI agents
  to do sales, marketing, revops, and AI-ops work, not to write software. They span
  a wide technical range, from people who never open a terminal to fairly technical
  non-developers. Assume light familiarity with the language of agents, not fluency.
  Use plain words: file, folder, session, project, source.
- **Never talk down.** Don't over-explain, and don't pad a term with a definition
  the reader may not need. Explain a term once, then trust the reader. For the
  language-of-agents terms, link to the [Glossary](/glossary) on first use instead
  of defining inline (see the technical-writing guide), so the unfamiliar can learn
  and the familiar can move on.
- **Don't name code internals.** Describe the effect the reader observes, not the
  implementation. "Re-reads your transcripts from disk," not "clears the structural
  index." Internal vocabulary (table names, layer numbers, fragments, fact rows)
  stays off published pages. The `docs/internals/` pages are the exception: they
  document internals on purpose and are excluded from the published site.
- **Product names.** Anthropic styles it **Claude Cowork** (lowercase "w"). Use that
  exact casing. The other sources are Claude Code, Codex, and Gemini.
- **Never use real data.** This is a public repo. Synthesize obviously-fake
  examples (`/Users/you`, `user@example.com`). Never paste real paths, names,
  emails, tokens, or transcript content.

## Cut on sight

The tells that make writing read as generic or machine-made. Scan for these before
calling a draft done.

- **Marketing buzzwords:** unlock, supercharge, leverage, empower, streamline,
  seamlessly, world-class. Say what actually happens instead.
- **The rhetorical reframe:** "That's not X, it's Y." Keep the half that does real
  work, cut the setup.
- **Filler emphasis:** "Here's the thing:", "Let's be clear:". Just say the thing.
- **Self-certifying honesty:** "honestly," "to be honest," "frankly." Cut the
  qualifier and make the claim.
- **Passive voice.** Say who does what.
- **Over-explaining the value.** State the outcome and trust the reader.
- **Example-stuffing.** An abstract phrase with a list of specifics bolted on to
  prove you were concrete. Trust the description, or give the single sharpest
  example.
- **Sentence-long bolding.** Bold one surgical phrase or a term, never a whole
  sentence.
- **Consultant-speak:** leverage to "use," utilize to "use," pain point to
  "problem." Reach for the plainer word.

## No em-dashes

Don't use em-dashes in Argus docs. Not as a connector, not as a parenthetical pair,
not as a trailing aside. Use commas or parentheses for an aside, a colon or a new
sentence for a supplement, and a conjunction (or two sentences) for a connector.
This is a bright line ADC holds because agent-drafted copy reaches for em-dashes
constantly, so it's easier to hold the line than to ration them.

## Before you ship

- [ ] Buzzword or consultant-speak, swap for the plainer word
- [ ] Rhetorical reframe ("not X, it's Y"), keep the real half
- [ ] Filler emphasis or self-certifying honesty, cut it
- [ ] Passive voice, say who does what
- [ ] Over-explaining, state the outcome and stop
- [ ] Code internals on a user-facing page, describe the observable effect
- [ ] Real paths, names, or data, swap for fake fixtures
- [ ] Any em-dash, use a comma, parentheses, colon, or conjunction
- [ ] Reads like a sales pitch (tagline, CTA, social proof, promised benefit), make it a plain statement
- [ ] Could this paragraph be a sentence? Could this sentence be cut?
- [ ] Read it aloud: does it sound like a person, or a brochure?
