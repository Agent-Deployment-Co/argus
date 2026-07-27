# Audience

Who Argus is for. This is the canonical definition, and it sits upstream of
everything else: what we claim, how we sound, which words we use, how a page is
built. When another guide needs the audience, it links here instead of restating
it.

Read this first. Most bad Argus copy comes from writing for the wrong reader,
not from writing badly.

## Who they are

People who use AI agents to get go-to-market work done, not to write software.
Think sales, marketing, revops and AI-ops: a rep researching accounts with
Claude, a marketer drafting and editing content, a revops practitioner building
reports and small apps, an AI-ops leader watching agent use across a team.

What unites them is the work, not the tooling. They point agents at their actual
job. Software is not the output.

## The technical range

They span a wide range, and the two ends need different things from the same
page.

- **One end never opens a terminal.** They installed the desktop app, and the app
  is the whole product to them. A page that starts with a command has lost them.
- **The other end is fairly technical but still not a developer.** Technical
  revops, GTM engineers. They can use the terminal, run Claude Code, write the
  occasional script. They can handle a CLI.

Write the main path for the first group and offer the second group the shortcut.
See [desktop first](./technical-writing.md#usage-model-desktop-first).

Assume light familiarity with the language of agents, not fluency. They know what
a session and a prompt are. They may not know what an MCP server is. They have
not read the source, and never will.

## Two reading modes

- **Single-player.** One person understanding their own agent use and getting
  more out of it. This is most readers, and the default you write for.
- **Multi-player.** An ops or AI-ops reader looking across many people's use,
  building shared skills and connectors for them. This is the
  [Argus Hub](/argus-hub) reader, and a real audience rather than an afterthought:
  a company runs a Hub, its people opt in, and the org gets a pooled view of how
  agents are actually being used.

A page usually serves one mode. When it serves both, lead with single-player.
Don't treat the multi-player mode as a caveat on the single-player one. See
[the app and the Hub](./positioning.md#the-app-and-the-hub).

## Who Argus is not for

Developers doing developer workflows. Argus indexes sessions from coding agents,
so a developer can point it at their own work and it will function, but they are
not who it's built for and not who we write for.

This boundary does real work. It's why the examples are account research and
content drafting rather than refactoring and test coverage, why the taxonomies
avoid software vocabulary, and why the desktop app is the main path.

## Rules that follow from this

- **Never call them "non-coders."** It defines a reader by what they can't do.
  Name what they do instead: business work, go-to-market work, their actual job.
  This holds on every surface, not just the docs.
- **Never assume a developer.** Not in examples, not in taxonomies, not in the
  default path through a page, not in a feature's design.
- **Never talk down.** Explain a term once and trust the reader to keep up. Don't
  pad a term with a definition they may not need. Link
  [terms on first use](./technical-writing.md#link-terms-on-first-use) so the
  unfamiliar can learn and the familiar can keep moving.
- **Use plain words.** File, folder, session, project, source. Not the words the
  code uses. See [Terminology](./terminology.md).

## Using this beyond writing

The audience governs product decisions too, not just copy. When you choose a
default, name a feature, design an empty state, or pick what a taxonomy contains,
assume this reader. A feature that only makes sense to a developer is a feature
aimed at the wrong person, however well it's documented.
