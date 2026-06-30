# Introduction

**Argus audits how you use Claude Code, Codex, and Gemini CLI.** It reads your local
session transcripts and makes them legible — usage, cost, tools, skills, and session
health — in one place. Everything is local-first: parsing happens on your machine, and
nothing is uploaded unless you explicitly run `sync`.

Argus can:

- **Serve an interactive dashboard** at a local web address (`serve`) — the preferred way to
  explore your usage.
- **Upload usage snapshots** to the [Argus dashboard](https://argus.agentdeployment.co), where
  you can keep and analyze your data over time (`sync`).
- **Run all of it as one always-on process** (`run`) — keep the local data current, serve the
  web app, and upload on a schedule, so the dashboard is live whenever you want it.

## Quick start

Argus's published CLI requires Node.js 20.17 or newer. Run it directly with `npx` — open the
interactive dashboard in your browser:

```bash
npx @agentdeploymentco/argus serve --open
```

This starts a local web server (default `http://localhost:4242`) and opens it. Press `Ctrl-C`
to stop. Nothing leaves your machine — it reads your local transcripts and serves them locally.

## What the web app shows

- Tokens and estimated cost over time
- Claude, Codex, and Gemini source breakdowns
- Skill, tool, MCP server, plugin, model, and project attribution
- Tools that return the most content to your context
- Per-session duration, tokens, cost, prompts, and summaries

## Where to go next

- **[Installation](/installation)** — install the macOS menu bar app, or run the CLI through `npx`.
- **[Configuration](/configuration)** — settings, flags, and environment variables.
- **[Argus Hub](/argus-hub)** — collect usage across a team and view an org-wide dashboard.
