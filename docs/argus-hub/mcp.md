---
description: Query an Argus Hub from an agent over MCP, the full tool list, filters, authentication and a worked example.
---

# Argus Hub: MCP

Argus Hub exposes its data through [MCP](https://modelcontextprotocol.io) at
`POST /mcp`, so an agent can answer questions about the organization's
usage directly, instead of someone opening the dashboard. It's read-only:
nothing an agent sends through this endpoint changes what's synced or
who's in it, apart from the label tools below, which only add or remove an
Argus Hub label.

## Transport

The endpoint uses the stateless Streamable HTTP transport: every request
is a self-contained JSON-RPC call over a single POST to `/mcp`, and Argus Hub
answers it without any `initialize` handshake or session to keep alive.
There's nothing to warm up and nothing cached between calls, so an MCP
client can send `tools/list` or `tools/call` straight away.

## Authentication

Authenticate with Argus Hub's admin password, the same one that unlocks the
dashboard:

```text
Authorization: Bearer <admin-password>
```

Argus Hub rejects a missing or wrong password before reading the request
body. If Argus Hub runs with no admin password configured, `/mcp` is open to
anyone who can reach it, so set one for any Argus Hub reachable outside your own
machine.

For Claude Code:

```bash
claude mcp add --transport http argus-hub https://hub.internal:4343/mcp \
  --header "Authorization: Bearer <admin-password>"
```

Treat the password as a shared read (and light write) credential once
you've given it to an agent. Anyone holding it can query the
organization's activity, tasks and tool usage, and add or apply labels.

## Filters

`query_activity`, `query_tasks`, `query_task_quality` and `query_tool_usage`
share one set of filters:

| Filter | Meaning |
|---|---|
| `since`, `until` | Date range (`YYYY-MM-DD`), inclusive. Defaults to the last 30 days if omitted. |
| `project` | Substring match on the project path. |
| `source` | One of `claude`, `codex`, `gemini`, `cowork`. |
| `user` | One `userId`, from `query_users`. Omit for the whole organization. |
| `group` | A `groupId`, or `__none__` for people with no group. |

`query_tasks` adds `q` (free-text search), `outcome` (comma-separated
`success`, `failure`, `unknown`) and paging with `limit` (default 50,
maximum 200) and `offset`. `query_users` only takes `group`. It's a
roster, not a windowed report, so it's the tool to call first to find a
`userId` before scoping the others.

## Tools

| Tool | What it answers |
|---|---|
| `query_users` | The roster: user IDs, display names, emails, group, last-sync time, sessions, tokens and cost. |
| `query_activity` | Usage and cost over the window, plus the same figures for the prior window for comparison. |
| `query_tasks` | A paged, filterable list of tasks, with outcome counts for the filtered set. |
| `query_task_quality` | Success, frustration and friction rates, outcomes over time, and the top failure signals. |
| `query_tool_usage` | Which tools, skills and MCP servers people use, and how usage compares across sources. |
| `list_labels` | Every [Argus Hub label](/argus-hub/tasks#argus-hub-labels) defined on this Argus Hub, with how many tasks carry it. |
| `create_label` | Adds a new Argus Hub label. |
| `set_task_label` | Applies or removes an Argus Hub label on one task. |

A query tool with no matching data returns an empty result (an empty task
list, an empty roster) rather than an error. `query_activity` and
`query_task_quality` are the exception: they return an error when the
organization has no data at all in the window.

## A worked example

Ask an agent something like:

> Who on the team has the highest Claude Code spend this month, and does
> their task success rate look normal?

A reasonable path: call `query_users` to find people, `query_activity`
scoped to `source: "claude"` and this month's `since`/`until` to rank
spend, then `query_task_quality` with the same filters (or `user` set to
the top spender) to read their success and frustration rates against the
organization's.

Every tool's response comes back as a JSON string in the result content,
so have the agent parse it rather than expect structured fields directly
on the MCP response.
