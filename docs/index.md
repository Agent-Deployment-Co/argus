# Introduction

**Argus shows you how you use your AI [agents](/glossary#agent).** It reads the
[transcripts](/glossary#transcript) that Claude Code, Codex, Claude Cowork, and
Gemini leave on your computer and turns them into a clear picture of how you work
with them.

Everything stays local. Argus reads your transcripts on your own machine, and
nothing is uploaded unless you choose to [sync](/glossary#sync) it to an
[Argus Hub](/glossary#argus-hub).

## Get started

Install the desktop app and you're set: it keeps your usage up to date and opens
your [dashboard](/glossary#dashboard) in your browser, with no extra setup. See
[Installation](/installation) to download it for Mac.

Prefer the command line? Argus also runs as a command-line tool through `npx`
(needs Node.js 20.17 or newer):

```bash
npx @agentdeploymentco/argus serve --open
```

This starts a local dashboard (default `http://localhost:4242`) and opens it.
Press `Ctrl-C` to stop. Nothing leaves your machine.

## What the dashboard shows

- [Tokens](/glossary#token) and estimated [cost](/glossary#cost) over time
- A breakdown by [source](/glossary#source): Claude Code, Claude Cowork, Claude Chat, Codex, and Gemini CLI
- The [skills](/glossary#skill), [tools](/glossary#tool), [MCP servers](/glossary#mcp-server), [plugins](/glossary#plugin), [models](/glossary#model), and [projects](/glossary#project) you use most
- The tools that send the most content back into your agent's context
- Per-[session](/glossary#session) time, tokens, cost, and prompts

## Where to go next

- **[Installation](/installation):** install the Mac app, or run the command-line tool through `npx`.
- **[Configuration](/configuration):** settings, flags, and environment variables.
- **[Argus Hub](/argus-hub):** collect usage across a team and view an org-wide dashboard.
