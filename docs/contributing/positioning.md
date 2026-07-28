# Positioning

What we claim Argus does, and which claim goes where. This is the canonical
source. When a description of Argus appears anywhere, from a 20-character button
to a conference talk, it comes from here.

This page owns *what we say*. [Audience](./audience.md) owns *who we say it to*,
[Voice and tone](./voice-and-tone.md) owns *how we sound*, and
[Terminology](./terminology.md) owns *what we call things*.

## The promise

**Argus finds and fixes wasted agent work.**

That's the whole idea, and everything else supports it. People run agents on
business work all day and can't see what came of it. Argus shows them the work
that failed, repeated, or cost more than it should.

Lead with that. Don't lead with "analyzes AI agent usage", which names a
mechanism and leaves the reader to work out why they'd care. The mechanism is how
we earn the promise, not the promise itself.

This is about position, not vocabulary. "Analyzes your sessions" is an accurate
description of what Argus does and it's fine further in, once the reader knows
why it matters. See
[what Argus does with your data](./terminology.md#what-argus-does-with-your-data).

## The app and the Hub

Two capabilities worth stating plainly.

**Argus is a desktop app.** Signed and notarized on macOS, signed on Windows,
installed the way any other app is installed, and it updates itself. For a reader
who isn't going to run a binary from a terminal, that's the difference between a
tool they can use and one they can't. Lead with the app. The CLI is the
alternative for people who want it, not the main path.

**Argus has a multi-player mode.** A company can run an [Argus Hub](/argus-hub/),
each person points their Argus at it, and the org gets a pooled view of how
agents are being used. Starting one is a single command, and joining it is a URL
and a key in Settings.

The Hub is a capability, so describe it as one. The facts that matter:

- It's opt-in, and off until someone configures it.
- The company runs it themselves. Data goes to their server, not to us.
- Raw prompt and response text stays on each person's machine, as do their API
  keys.

Argus is for the person doing the work, and the Hub is a view for the team
they're on. It isn't there to watch individuals. See
[what Argus is not](#what-argus-is-not).

## Canonical descriptions

There are two, because there are only two shapes of slot to fill. Where just a
few words fit, use [the promise](#the-promise) itself.

**The one-liner**, for any field with a character budget: the GitHub About, meta
descriptions, `og:description`, package registries.

> Argus is a desktop app that helps find and fix wasted agent work. Local, free
> and open source. Focuses on business tasks, not code. Works with Claude Cowork /
> Chat / Code, ChatGPT Work and Codex.

**The lede**, for a README or a docs homepage, where there's room to say who it's
for and what you get.

> Argus is a desktop app that helps you find and fix wasted agent work. It's
> built for people using AI for business tasks. These tasks are usually more
> open-ended and need more external context than coding, making for
> some frustrating agent interactions. Argus analyzes your AI sessions to
> identify those costly, repetitive or unsuccessful tasks. It's free, open
> source and runs locally on Mac or Windows. Argus works with Claude Cowork,
> Claude Chat, Claude Code, ChatGPT Work and Codex.

Writing a variant is fine. Writing one that contradicts these is not. Keep the
[terminology](./terminology.md) rules when you do: Argus **finds and indexes**
sessions, it doesn't read, load or import them.

## Which agents a description names

How each agent is written is [terminology](./terminology.md#agent-names), and the
supported list comes from the code. Take both from there.

What belongs here is which of them a description carries when there isn't room
for all of them.

**Both canonical descriptions name Claude Cowork, Claude Chat, Claude Code,
ChatGPT Work and Codex, in that order, and leave Gemini CLI out.** The order is
[knowledge work, then chat, then coding](./terminology.md#the-three-kinds-of-agent).
Argus supports Gemini CLI, and it belongs everywhere the full list appears: the
[Supported agents](/supported-agents) page, the docs, the repo topics. It stays
out of the descriptions.

Codex and ChatGPT Work both get named even though one source covers them, because
they're [two different products](./terminology.md#codex-and-chatgpt-work-are-two-things)
and Work is the one our reader is most likely to be using.

## Register by surface

[Voice and tone](./voice-and-tone.md) rules out taglines, calls to action and
promised benefits. That rule was written for reference documentation and it holds
there. Outward-facing surfaces are different: their job is to help someone decide
whether Argus is worth their time, and a plain statement of the promise is the
honest way to do that.

| Surface | Register |
|---|---|
| Docs pages | Plain. State what Argus does and what the reader sees. No taglines, no calls to action, no selling the outcome. |
| README, repo description, social cards | May lead with the promise. Still plain underneath it. |
| Outreach, talks, posts | May lead with the promise, and may argue for it. |
| Terminal output, UI strings | Plain, always. Never market to someone mid-task. |

Both registers hold the same lines:

- No buzzwords or consultant-speak. The
  [cut on sight](./voice-and-tone.md#cut-on-sight) list applies everywhere.
- No invented or aspirational social proof.
- No em-dashes. See [no em-dashes](./voice-and-tone.md#no-em-dashes).
- Never describe something as shipping when it hasn't.

## Claims we can make

A claim is safe when a reader can open Argus and see it. Prefer the specific,
checkable version every time.

| Say | Don't say |
|---|---|
| Shows you the tasks that failed | Makes your agents more reliable |
| Estimates cost from published API prices | Cuts your AI spend |
| Runs on your machine, nothing is uploaded | Enterprise-grade security |
| Indexes the agents on the Supported agents page | Works with every AI tool |
| Free and open source, MIT licensed | Free forever |

Two claims need care because they're easy to overstate:

- **Cost is an estimate.** It comes from published API prices and won't match a
  subscription bill. Say estimated, every time.
- **Friction signals are Claude only.** Interruptions, declined tool actions and
  compactions aren't reported by Codex or Gemini. Don't imply coverage we don't
  have.

## Answering the privacy question

This is the first question a thoughtful reader asks, and it deserves a straight
answer. Don't get defensive about it, and don't bury it.

The short answer: **Argus reads files your agents already wrote to your disk, and
keeps what it derives on the same machine.** If a company runs a
[Hub](#the-app-and-the-hub), people can opt in to sending their usage to it, and
that goes to the company's own server.

Details worth having ready:

- Your prompt and response text never leaves the machine, even with sync on.
- Interpretations built from that text (a task's outcome, a session summary) do
  upload when sync is on. Say so plainly rather than letting someone discover it.
- BYO API keys stay local.
- The desktop app checks GitHub for updates on a schedule. That's a network
  call, so disclose it rather than claiming nothing ever leaves.

The temptation is to say "nothing leaves your machine" because it's clean. It's
also not quite true once sync or update checks are in play, and a privacy claim
that turns out to be approximate costs more than the one it bought.

## What Argus is not

Being clear about this saves more words than any description.

- **Not a developer tool.** It indexes sessions from coding agents among others,
  but it's built for business work. See [Audience](./audience.md).
- **Not monitoring or compliance software.** Argus is for the person whose work
  it is, and the [Hub](#the-app-and-the-hub) is a view for the team they're on.
  Never describe either as oversight of individuals.
- **Not a cloud service.** Argus runs on your machine, and a Hub runs on the
  company's own server. Neither sends anything to us.
- **Not an agent, and it doesn't change how agents behave.** It reads what they
  already wrote.

## Related projects

Other people are working on this too. These are two we've read, and there are
others we haven't. When someone asks how Argus relates to them, answer plainly,
and send them elsewhere when the other tool is the better fit.

**[ccusage](https://github.com/ryoppippi/ccusage)** analyzes token usage and cost
from local agent data, reported by day, week, month and session. If what someone
wants is to know what their agents cost, it does that, and it does it narrowly on
purpose. Argus reports cost too, but as a way into the work behind the number
rather than as the answer.

**[AgentsView](https://github.com/kenn-io/agentsview)** is local-first session
search, analytics and token statistics for coding agents, across more than twenty
of them. Someone who wants to browse and search their coding sessions is probably
better served there. Argus overlaps with it a good deal, including local
indexing, full-text search, a dashboard and model-written summaries, and it
covers fewer agents.

It also ships code-signed macOS and Windows desktop apps, including a homebrew
cask, and it has a team mode that pushes session data to a shared PostgreSQL
instance for a read-only team dashboard.

The two multi-player setups ask different things of you. An
[Argus Hub](/argus-hub/) starts with one command and is joined with a URL and a key
in Settings. AgentsView expects a PostgreSQL instance you provision and run.

Argus's niche is the reader neither of them is aimed at: someone doing business
work rather than writing software, who wants to know which of that work went
nowhere. That's a different reader, not a better one.

Two rules:

- **Don't claim novelty we don't have.** Local indexing, session search,
  model-written summaries, signed desktop apps and team views all exist
  elsewhere. Describe them as things Argus does, not as things only Argus does.
- **Don't characterize a project we haven't read**, and that includes saying a
  tool lacks something. Check first, or say nothing.

Both projects are active and change often. Re-read them before repeating anything
from this page.

## Surface inventory

Every place a description of Argus appears. When the canonical wording changes,
work this list. A description that drifts on one surface is how readers end up
with two different ideas of what Argus is.

| Surface | Location | Use |
|---|---|---|
| GitHub About | repo settings | One-liner |
| GitHub topics | repo settings | n/a |
| GitHub social preview | repo settings | Promise |
| README lede | `README.md` | Lede |
| Docs meta description | `docs/.vitepress/config.ts` (`description`) | One-liner |
| Docs `og:title` | `docs/.vitepress/config.ts` (`head`) | Promise |
| Docs `og:description` | `docs/.vitepress/config.ts` (`head`) | One-liner |
| Docs lede | `docs/index.md` | Lede |
| About page | `docs/about.md` | Lede |
| npm package | `package.json` (`description`), shipped by `scripts/build-npm-packages.ts` | One-liner |
| npm platform packages | `scripts/build-npm-packages.ts` | n/a |
| Web app title | `web/index.html` | n/a |
| Desktop app | `desktop/src-tauri/tauri.conf.json`, `desktop/ui/about.html` | n/a |

The demo site serves the web app, so it inherits `web/index.html`.

## Before you ship outward-facing copy

- [ ] Leads with the promise, not the mechanism
- [ ] Written for the [audience](./audience.md), and never calls them "non-coders"
- [ ] Every claim is one a reader could open Argus and verify
- [ ] Cost described as estimated, friction described as Claude only
- [ ] Agent names and the supported list match
      [terminology](./terminology.md#agent-names) and the code
- [ ] Both descriptions name the five agents in order, Gemini CLI left out
- [ ] Register matches the surface
- [ ] No buzzwords, no invented social proof, no em-dashes
- [ ] Nothing described as shipping that hasn't shipped
- [ ] Matches the canonical description above, or the canonical description was
      updated first
