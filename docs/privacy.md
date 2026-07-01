# Privacy and Security

Argus is built to keep your data on your own machine. This page lays out what it
reads, what it stores and the few times anything leaves your computer.

## Open source and local

Argus is a free and open source tool,
[MIT licensed](https://github.com/Agent-Deployment-Co/argus/blob/main/LICENSE),
so you can read exactly what it does. It runs entirely on your own computer.
Installing it and browsing your usage needs no account and no server.

## What it reads and stores

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
