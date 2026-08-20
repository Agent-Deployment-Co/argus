---
description: What Argus reads from your machine, what it stores and the few times anything leaves your computer.
---

# Privacy and Security

Argus is built to keep your data on your own machine. This page lays out what it
reads, what it stores and the few times anything leaves your computer.

## Open source and local

Argus is a free and open source tool,
[MIT licensed](https://github.com/Agent-Deployment-Co/argus/blob/main/LICENSE),
so you can read exactly what it does. It runs entirely on your own computer.
Installing it and browsing your usage needs no account and no server.

## Indexing and storage

Argus finds and indexes the [sessions](/terminology#session) your AI agents have
already saved to your own disk (see [Supported Agents](/supported-agents) for the
locations it reads). Indexing is entirely local: it reads those files, pulls out
the useful details and saves them to a local [index](/terminology#index), a
database on your computer. It doesn't watch your screen or record anything as you
work. Everything it needs is already on disk.

## Credential warnings

As it indexes, Argus checks your session text for credentials you may have pasted
into a conversation, like an API key, a token or a private key. The check is pattern
matching on your own machine: no model reads it, and nothing is sent anywhere.

What Argus keeps from a match is deliberately thin. It records the kind of
credential, where in the session it appeared and a few characters of the value,
enough to tell you which key it was and not enough to use it. The credential itself
is never copied into the [index](/terminology#index).

Warnings stay on your computer. A [sync](/terminology#sync) uploads none of them.
What an [Argus Hub](/terminology#argus-hub) does receive is one yes or no on each
[task](/terminology#task), saying whether a warning landed in it, so whoever runs the
Hub can see that a piece of work touched a credential and ask you to rotate it. The
kind, the location and those few characters all stay local. Dismissing a warning in
your own Argus hides your banner and leaves that flag in place, since the flag
records that the work touched a credential rather than that you've read the warning.

## Task interpretation and model providers

[Task interpretation](/tasks) is the one part of Argus that uses a model to read
your sessions. It's on by default, and you choose which
[model](/terminology#model) provider does the reading, or turn it off entirely.
To judge how a [task](/terminology#task) went, Argus sends that task's prompts and
responses to the provider you chose, so some of your session content is shared
with that provider. The default sends it to Anthropic through your Claude
sign-in; the hosted providers send it to their own services. Only a local model
run through the Command provider keeps it on your machine. See [Tasks](/tasks)
for the full picture.

## Agent access

Argus can let AI agents on your computer query your data themselves over a local
[MCP](/terminology#mcp-server) endpoint, so an agent can answer questions about
your past work. It's on by default, and it's read-only: an agent can look at
your sessions, usage and task outcomes, but can't change anything. Local agents
can use it without a token. A container or another computer needs the bearer
token configured with `ARGUS_MCP_TOKEN`, and Argus still sends nothing anywhere
itself unless you run `sync`.

The one sensitive piece is transcripts. Reading one sends the full text of that
conversation into the agent's model provider's context, so transcript access
ships off. Turn it on under **Settings → Agent access** only if you're
comfortable with that. See [Connect Your Agent](/connect-your-agent) for how it
works.

## Serving to other computers

Argus answers only on the computer it runs on. The desktop app always works that
way. The command line does too, unless you ask for something else: `serve --host`
takes an address to listen on, for running Argus on a machine you don't sit at and
opening it from your laptop.

Argus has no sign-in, so anyone who can reach that port can read what's in your
[index](/terminology#index), including the prompt and response text Argus keeps
when **Retain session text** is on. Use it only on a network you trust, and add
`--read-only` so a visitor can't change anything. Settings and stored API keys are
the exception: those answer only on the computer running Argus, whatever address
you bind. See
[Opening Argus to your network](/cli-reference#opening-argus-to-your-network).

Opening a port doesn't make Argus send anything anywhere. It changes who can read
what's already on your own machine.

## API keys

When you use a provider that needs an API key, Argus stores the key in your
operating system's secure store (the Keychain on macOS), never in its settings
file and never on any server. It reads the key from there only to call the
provider you configured.

## Updates

The desktop app checks for new versions on a schedule and downloads them in the
background. The **Updates** setting in [Settings](/settings) controls whether new versions automatically install; with it off, Argus still checks and tells you when one is ready, and you install it from the menu bar. The command-line tool doesn't check for updates at all.

Those checks and downloads go through a download service The Agent Deployment
Company runs, and they carry one detail about your copy of Argus: a random
identifier it creates on your computer the first time it runs. It lets us count
how many installs are checking for updates, rather than counting the same
computer over and over. It isn't tied to your name or your email, and nothing
about your sessions, your settings or your usage goes with it. New versions
themselves are hosted on GitHub, so when Argus downloads one, that identifier
reaches GitHub along with the request. If you [sync](/terminology#sync) to an
[Argus Hub](/terminology#argus-hub), it's the same identifier the Hub uses to tell
your uploads apart from a colleague's.

If you'd rather not be counted, turn off **Share update metrics** in
[Settings](/settings). Argus still checks for updates and still installs them; the
checks just don't say which install they came from.


## Argus Hub

By default, Argus uploads nothing. If your organization runs an
[Argus Hub](/terminology#argus-hub), you can opt in to
[sync](/terminology#sync) a snapshot of your usage to it, so an ops leader can
see agent use across the team. Two things to know:

- **The Hub is hosted by your own organization**, not by The Agent Deployment
  Company. Your data goes to your company's server, not to us.
- **What's sent stays minimal.** A sync carries your metrics and task data
  (usage totals, breakdowns, outcomes and the like), plus a few short text
  snippets: a session's opening prompt and the brief evidence behind a task's
  judgment. The full text of your sessions is never uploaded, and neither are the
  details of a [credential warning](#credential-warnings), only a flag on the tasks
  one applies to.
