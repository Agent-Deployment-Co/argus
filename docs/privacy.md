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
  judgment. The full text of your sessions is never uploaded.
