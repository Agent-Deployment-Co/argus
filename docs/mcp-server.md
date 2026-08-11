---
description: Connect an agent to the local Argus MCP server in Claude Code, Claude Cowork, Codex, Cursor, Gemini CLI or VS Code, with the full tool reference and worked examples.
---

# MCP Server

Argus serves a local [MCP](/terminology#mcp-server) endpoint at
`http://127.0.0.1:4242/mcp` whenever it's running, so an agent on your computer
can answer questions about your own agent use: what you worked on, what it cost,
which tools you leaned on and where [sessions](/terminology#session) went
sideways. This page covers connecting each agent and what the six tools return.
For what the feature is and how to turn it off, see
[Connect Your Agent](/connect-your-agent).

Every tool is read-only, so an agent can't change your data through it. The
endpoint listens on your own computer only, needs no key, and answers nothing but
the agent that called it.

## Before you connect

- **Argus has to be running.** Open the desktop app, or run
  `npx @agentdeploymentco/argus run` in a terminal.
- **The address is `http://127.0.0.1:4242/mcp`.** If port 4242 was already taken,
  the app moves to another one, and the dashboard address in your browser shows
  which. On the command line it follows `--port` or `ARGUS_PORT`.
- **Agent access has to be on.** "Let agents query Argus" is on by default, under
  **Settings → Agent access**.

## Setup

Every agent below connects over the same address. The one exception is Claude
Chat, which can't reach it at all: a custom connector there is called from
Anthropic's servers rather than from your computer, so an address on your own
machine isn't visible to it.

### Claude Code

```bash
claude mcp add --transport http argus http://127.0.0.1:4242/mcp
```

That adds Argus for the folder you're in. Add `--scope user` to get it in every
project. `claude mcp list` shows whether it connected.

### Claude Cowork and Claude Desktop

Cowork runs inside the Claude desktop app, which starts local connectors as a
command rather than calling an address, so run a bridge in front of the endpoint.
In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "argus": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:4242/mcp", "--allow-http"]
    }
  }
}
```

Restart the app afterwards. `--allow-http` is needed because the address is plain
`http` on your own machine.

### Codex

In `~/.codex/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.argus]
url = "http://127.0.0.1:4242/mcp"
```

Both lines matter: without `experimental_use_rmcp_client`, Codex only starts
connectors that run as a command. `codex mcp add` covers that kind, so edit the
file for an address like this one.

### Cursor

In `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "argus": { "url": "http://127.0.0.1:4242/mcp" }
  }
}
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "argus": { "httpUrl": "http://127.0.0.1:4242/mcp" }
  }
}
```

Use `httpUrl`, not `url`. Gemini CLI reads `url` as an older streaming transport
that this endpoint doesn't serve. Type `/mcp` inside Gemini CLI to check.

### VS Code

In `.vscode/mcp.json` for the folder you're working in, or in your user
configuration through **MCP: Open User Configuration**:

```json
{
  "servers": {
    "argus": { "type": "http", "url": "http://127.0.0.1:4242/mcp" }
  }
}
```

### Anything else

Any client that speaks MCP over HTTP can point straight at the address. Each call
is a self-contained request, so there's no session to keep alive and no
credential to configure. For a client that only starts connectors as a command,
use the `mcp-remote` bridge shown under
[Claude Cowork](#claude-cowork-and-claude-desktop).

## Checking the connection

Most agents list their connectors for you (`claude mcp list`, `/mcp` in Gemini
CLI). To check the endpoint itself:

```bash
curl -s http://127.0.0.1:4242/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Six tool names come back. A `404` means agent access is off, and a browser
visiting the address gets `405`, since the endpoint only answers posted requests.

## What agents can ask

| Question | Tool |
|---|---|
| "What did I work on last week?" | `search_sessions` |
| "How did the Wallace renewal research go?" | `search_sessions`, then `get_session` |
| "Show me what I actually asked in that session." | `get_session_transcript` |
| "What did agents cost me in June, by project?" | `usage_summary` |
| "Which connectors and skills do I really use?" | `tool_usage` |
| "Where am I losing time?" | `health_summary` |

The examples below are the raw calls, so you can see the shape of the answers.
In practice you ask in plain language and the agent picks the tool.

### Filters

`search_sessions`, `usage_summary`, `tool_usage` and `health_summary` share four
filters. Leave them out to cover everything Argus has indexed.

| Filter | Meaning |
|---|---|
| `since`, `until` | Calendar dates as `YYYY-MM-DD`, and both ends count. Agents work out ranges like "last week" themselves and pass the dates. |
| `source` | One agent: `claude` (Claude Code), `cowork` (Claude Cowork), `claude-chat` (Claude Chat), `codex` (Codex) or `gemini` (Gemini CLI). |
| `project` | Sessions whose [project](/terminology#project) name contains this text. |

### search_sessions

Finds sessions by text, by a file they touched, or by date, agent and project.
Takes `query`, `file`, the shared filters, `sort` (`recent`, `tokens` or `cost`)
and `limit` (20 by default, 50 at most). The sessions Argus creates for itself
when it summarizes your work are left out.

```json
{
  "name": "search_sessions",
  "arguments": { "query": "pricing", "since": "2026-06-01", "until": "2026-06-30", "limit": 2 }
}
```

```json
{
  "sessions": [
    {
      "sessionId": "claude-chat:42c23ba2-6cea-47f1-8642-2e04e575cabd",
      "source": "claude-chat",
      "project": "competitive-research",
      "title": "How does Meridian Software position against us?",
      "summary": "Compared Meridian Software's positioning and pricing tiers to ours and called out two gaps to exploit.",
      "start": 1782932585191,
      "end": 1782933601027,
      "userMessages": 5,
      "agentMessages": 5,
      "total": 7344,
      "cost": 0.053832,
      "interactions": 2,
      "tasks": 1,
      "match": { "count": 5, "snippet": "…positioning and pricing tiers to ours and called…", "sources": ["summary", "task"] }
    }
  ],
  "total": 6
}
```

`sessionId` is what every other session tool takes.

### get_session

One session in full: its title and summary, its [tasks](/tasks) with outcomes,
[tokens](/terminology#token) and cost, models, tools, files touched and friction
signals. Takes `session_id` and `include_task_metrics`, which adds per-task
tokens, cost and tool calls.

```json
{ "name": "get_session", "arguments": { "session_id": "cowork:152d1989-…", "include_task_metrics": true } }
```

```json
{
  "session": {
    "sessionId": "cowork:152d1989-…",
    "source": "cowork",
    "project": "exec-briefings",
    "title": "Draft the narrative for this quarter's board deck",
    "summary": "Verified the three headline metrics against the source sheet and drafted the board-deck narrative, though the speaker notes were left unfinished.",
    "total": 163795,
    "cost": 0.96255375,
    "models": ["claude-opus-4-1"],
    "toolCounts": { "Skill": 1, "Read": 3, "Write": 3, "mcp__gdrive__read_document": 2 },
    "tasks": [
      {
        "id": "cowork:152d1989-…#task-0",
        "description": "Pull the three headline metrics and check them against the source",
        "outcome": "success",
        "frustration": "none",
        "outcomeReason": "Numbers reconciled with the metrics sheet."
      }
    ],
    "health": { "interruptions": 3, "rejections": 2, "compactions": 1, "turns": 10, "medianTurnMs": 63397 }
  }
}
```

### get_session_transcript

The conversation itself, one exchange at a time, with the tokens and tool calls
each one used. Takes `session_id`, `offset` and `limit` (25 by default, 50 at
most). This is the one tool that's off until you allow it, so see
[Session text](#session-text) below.

```json
{ "name": "get_session_transcript", "arguments": { "session_id": "cowork:152d1989-…", "limit": 1 } }
```

```json
{
  "sessionId": "cowork:152d1989-…",
  "total": 7,
  "offset": 0,
  "limit": 1,
  "interactions": [
    {
      "seq": 0,
      "taskSeq": 0,
      "initiator": "human",
      "disposition": "completed",
      "promptText": "Pull the three headline metrics and check them against the source.",
      "responseText": "On it. I'll pull the three headline metrics and check them against the source.",
      "totalTokens": 42165,
      "toolCalls": 3,
      "tools": [{ "name": "Read", "count": 1 }, { "name": "Write", "count": 1 }]
    }
  ]
}
```

### usage_summary

Token and cost totals, grouped by `day`, `model`, `source` (the agent) or
`project`, plus the shared filters.

```json
{ "name": "usage_summary", "arguments": { "group_by": "project", "since": "2026-06-01", "until": "2026-06-30" } }
```

```json
{
  "groupBy": "project",
  "byProject": [
    { "name": "sales-agent-ops", "messages": 27, "total": 929537, "cost": 0.7326447, "meta": { "sessions": 3 } },
    { "name": "pipeline-hygiene", "messages": 41, "total": 714842, "cost": 0.236983, "meta": { "sessions": 6 } }
  ]
}
```

Grouping by `day` also returns period totals and a `daily` series, which is what
an agent uses to answer "how much did last week cost?"

### tool_usage

How your agents used their tools, grouped by `tool`, `category`, `mcp_server` or
`skill`, plus the shared filters. Each row carries call counts and roughly how
many tokens the results took up.

```json
{ "name": "tool_usage", "arguments": { "group_by": "mcp_server", "since": "2026-06-01", "until": "2026-06-30" } }
```

```json
{
  "groupBy": "mcp_server",
  "byMcpServer": [
    {
      "server": "hubspot",
      "calls": 22,
      "approxResultTokens": 86720,
      "topTools": [{ "tool": "search_contacts", "count": 15 }, { "tool": "list_deals", "count": 7 }]
    },
    { "server": "salesforce", "calls": 12, "approxResultTokens": 43845, "topTools": [{ "tool": "soql_query", "count": 12 }] }
  ]
}
```

### health_summary

Friction (interruptions, rejected permissions, compactions, slow turns) for the
whole window and per project, followed by the same recommendations the dashboard
shows. Takes the shared filters only.

```json
{ "name": "health_summary", "arguments": { "since": "2026-06-01", "until": "2026-06-30" } }
```

```json
{
  "frictionTotals": { "observableSessions": 26, "interruptions": 42, "rejections": 18, "compactions": 10, "turns": 188 },
  "byProject": [
    { "project": "pipeline-hygiene", "friction": { "observableSessions": 6, "interruptions": 16, "rejections": 10, "compactions": 5, "turns": 41 } }
  ],
  "recommendations": [
    {
      "id": "unused-plugins",
      "severity": "tip",
      "title": "2 plugins enabled but unused",
      "detail": "meeting-notes, seo-optimizer. Every enabled plugin's skills and MCP servers are included in every prompt's context."
    }
  ]
}
```

Friction comes from Claude Code and Claude Cowork sessions. Claude Chat, Codex
and Gemini CLI leave no record of it, so those sessions sit outside the counts
rather than counting as zero.

## Session text

Titles, summaries, task outcomes and totals are available to any connected agent.
The words you and the agent exchanged are not, until you say so, because reading
them sends that text into the model behind whichever agent asked.

**Let agents read session transcripts** (off by default, under
**Settings → Agent access**) is the switch. While it's off:

- `get_session_transcript` explains that it's off and what to turn on, rather
  than failing.
- `search_sessions` and `get_session` leave out your opening prompt, along with
  any search match that came from the conversation itself.

Both switches apply the moment you flip them, with no restart. Turning **Let
agents query Argus** off closes the endpoint entirely, and connected agents get a
`404`. See [Connect Your Agent](/connect-your-agent#transcript-access) for the
reasoning, and the
[settings reference](/settings-reference#app-and-general-settings) for the file
and environment equivalents.

## Without MCP

If an agent or script can't speak MCP, the same data is available two other ways.
`npx @agentdeploymentco/argus search "invoice" --json` searches sessions from the
command line, and the dashboard's own addresses answer on the same port, for
example `http://127.0.0.1:4242/api/usage/daily`. MCP is the better path when the
agent supports it, since the tools describe themselves to it.
